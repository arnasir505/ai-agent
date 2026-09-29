import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  type WASocket,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PREMIUM_TOOLS, executePremiumTool } from './tariffs.ts';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  throw new Error('ANTHROPIC_API_KEY environment variable is required');
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const MODEL = 'claude-sonnet-5';

const BUSINESS_INFO_PATH = path.join(__dirname, 'business-info.md');

// Loaded once at startup so the business info can be edited without
// touching this file — just update business-info.md and restart the bot.
function loadBusinessInfo(): string {
  try {
    return fs.readFileSync(BUSINESS_INFO_PATH, 'utf-8').trim();
  } catch {
    console.warn(
      `[startup] Could not read ${BUSINESS_INFO_PATH} — replying without business info.`
    );
    return '';
  }
}

const businessInfo = loadBusinessInfo();

const CONVERSATIONS_PATH = path.join(__dirname, 'conversations.json');

// Persists chat history to disk so restarting the bot doesn't wipe context.
function loadConversations(): Map<string, Anthropic.MessageParam[]> {
  try {
    const raw = fs.readFileSync(CONVERSATIONS_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, Anthropic.MessageParam[]>;
    return new Map(Object.entries(parsed));
  } catch {
    return new Map();
  }
}

function saveConversations(): void {
  const asObject = Object.fromEntries(conversations);
  fs.writeFile(CONVERSATIONS_PATH, JSON.stringify(asObject, null, 2), (err) => {
    if (err) console.error('Failed to save conversations:', err);
  });
}

const BASE_SYSTEM_PROMPT =
  'You are a helpful, friendly assistant chatting over WhatsApp. Keep replies short and conversational (a few sentences) unless the user asks for more detail. ' +
  'Write in plain text only. Never use any formatting: no bold, no italics, no asterisks, no underscores, no Markdown headings, no backticks. For lists use plain "- " or "1. " lines with no other symbols.';

const SYSTEM_PROMPT = businessInfo
  ? `${BASE_SYSTEM_PROMPT}\n\nUse the following business information to answer customer questions. If the answer isn't in this info, say you'll check and get back to them — don't make it up.\n\n${businessInfo}`
  : BASE_SYSTEM_PROMPT;

// The business info is ~23k tokens and goes out with every single message, so
// it dominates the bill. Tools render before the system prompt, so one
// breakpoint here caches the tool definitions and the business info together.
// Both are built once at startup, which keeps the cached prefix byte-identical
// across requests — editing business-info.md and restarting writes a new entry.
//
// Default 5-minute TTL, not the 1-hour variant: messages arrive roughly every
// 3 minutes, so each request refreshes the entry before it expires and the
// cache stays warm for free. The 1-hour TTL only pays off for 5-60 minute
// gaps between requests — at this message rate it would just double the
// write cost for no benefit.
//
// The date is appended because the model's own sense of "today" is stuck at
// its training cutoff, which made it misread clients' birth years. It changes
// once a day, so the cached prefix survives until midnight and costs one
// extra cache write per day.
function systemBlocks(): Anthropic.TextBlockParam[] {
  const today = new Date().toLocaleDateString('ru-RU', { dateStyle: 'long' });
  return [
    {
      type: 'text',
      text: `${SYSTEM_PROMPT}\n\nСегодняшняя дата: ${today}.`,
      cache_control: { type: 'ephemeral' },
    },
  ];
}

const MAX_HISTORY_MESSAGES = 20;

// How many times a single reply may go back to the model after running a
// premium calculator — one round covers the normal case, the rest leave room
// for a retry if the model passed invalid parameters.
const MAX_TOOL_ROUNDS = 4;

// Wait this long after the user goes quiet before replying, so bursts of
// messages get answered once instead of once per message.
const MIN_REPLY_DELAY_MS = 3_000;
const MAX_REPLY_DELAY_MS = 5_000;

// Extra "typing" pause before actually sending, so replies don't appear instantly.
const MIN_TYPING_DELAY_MS = 1_500;
const MAX_TYPING_DELAY_MS = 2_000;

// Wait this long before retrying a dropped connection (e.g. no internet),
// so a prolonged outage doesn't spin in a tight reconnect loop.
const RECONNECT_DELAY_MS = 5_000;

const FALLBACK_EMPTY_REPLIES = [
  'Хм, даже не знаю, что на это ответить.',
  'Извините, не получилось сформулировать ответ на это.',
  'Затрудняюсь ответить на этот вопрос.',
];

const FALLBACK_ERROR_REPLIES = [
  'Извините, при обработке произошла ошибка.',
  'Ой, что-то пошло не так с моей стороны.',
  'Возникла техническая заминка — не могли бы вы повторить сообщение?',
];

const conversations = loadConversations();
const pendingMessages = new Map<string, string[]>();
const replyTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Muted via "!bot off" / "!bot off all" sent from your own number, so you can
// take over a chat (or everything) without restarting the process.
const pausedChats = new Set<string>();
let globallyPaused = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBetween(minMs: number, maxMs: number): number {
  return minMs + Math.random() * (maxMs - minMs);
}

function pickRandom<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)] as T;
}

function extractText(message: any): string | undefined {
  return (
    message?.conversation ??
    message?.extendedTextMessage?.text ??
    message?.imageMessage?.caption ??
    message?.videoMessage?.caption
  );
}

// Safety net in case the model adds Markdown formatting despite the system
// prompt instructions — strips it so replies stay plain text.
function stripFormatting(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, '') // heading markers
    .replace(/(\*\*|__)(.*?)\1/g, '$2') // bold
    .replace(/(?<!\*)\*(?!\*)([^*\n]+)\*(?!\*)/g, '$1') // *italic*
    .replace(/(?<!_)_(?!_)([^_\n]+)_(?!_)/g, '$1') // _italic_
    .replace(/`([^`\n]+)`/g, '$1'); // inline code
}

// Trimming must not leave a tool_result as the first message — the API
// rejects a history whose opening message answers a tool call that is no
// longer there.
function trimHistory(
  history: Anthropic.MessageParam[]
): Anthropic.MessageParam[] {
  const trimmed = history.slice(-MAX_HISTORY_MESSAGES);
  const start = trimmed.findIndex(
    (message) =>
      message.role === 'user' &&
      (typeof message.content === 'string' ||
        !message.content.some((block) => block.type === 'tool_result'))
  );
  return start === -1 ? [] : trimmed.slice(start);
}

async function getReply(chatId: string, userText: string): Promise<string> {
  const history = conversations.get(chatId) ?? [];
  history.push({ role: 'user', content: userText });

  let reply = '';

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      // Sonnet 5 thinks before answering by default, and those thinking tokens
      // count against max_tokens — the old 1024 could cut a reply off mid-way.
      // This is a ceiling, not a cost: short replies still bill only what they use.
      max_tokens: 16000,
      // Low effort measured as accurate as medium on this bot's hardest case
      // (two drivers given by birth date) while cheaper and faster. Raise to
      // 'medium' if replies start showing shallow reasoning on calculations.
      // No `temperature`: Sonnet 5 rejects non-default sampling parameters.
      output_config: { effort: 'low' },
      system: systemBlocks(),
      tools: PREMIUM_TOOLS,
      messages: history,
    });

    // Cache hits are what make the large system prompt affordable. If `read`
    // is regularly 0 while `write` is not, requests are arriving more than
    // 5 minutes apart and the cache expires between them — switching the
    // breakpoint above to `{ type: 'ephemeral', ttl: '1h' }` would pay off.
    const usage = response.usage;
    console.log(
      `[usage] кэш: чтение ${usage.cache_read_input_tokens ?? 0}, запись ${usage.cache_creation_input_tokens ?? 0}, без кэша ${usage.input_tokens}`
    );

    const toolUses = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
    );

    if (toolUses.length === 0) {
      const textBlock = response.content.find(
        (block): block is Anthropic.TextBlock => block.type === 'text'
      );
      reply =
        stripFormatting((textBlock?.text ?? '').trim()).trim() ||
        pickRandom(FALLBACK_EMPTY_REPLIES);
      history.push({ role: 'assistant', content: reply });
      break;
    }

    for (const toolUse of toolUses) {
      console.log(`[tool] ${toolUse.name} ${JSON.stringify(toolUse.input)}`);
    }

    history.push({ role: 'assistant', content: response.content });
    history.push({ role: 'user', content: toolUses.map(executePremiumTool) });
  }

  conversations.set(chatId, trimHistory(history));
  saveConversations();

  return reply || pickRandom(FALLBACK_EMPTY_REPLIES);
}

function isPaused(chatId: string): boolean {
  return globallyPaused || pausedChats.has(chatId);
}

function clearPendingReply(chatId: string): void {
  const timer = replyTimers.get(chatId);
  if (timer) {
    clearTimeout(timer);
    replyTimers.delete(chatId);
  }
  pendingMessages.delete(chatId);
}

function clearAllPendingReplies(): void {
  for (const timer of replyTimers.values()) {
    clearTimeout(timer);
  }
  replyTimers.clear();
  pendingMessages.clear();
}

// Lets you mute the bot from your own WhatsApp account instead of restarting
// the process: send "!bot off" / "!bot on" in a chat to mute just that chat,
// or "!bot off all" / "!bot on all" to mute everywhere.
// Returns true if the text was a recognized "!bot ..." command (and handled
// it), false otherwise — so the caller can tell a control command apart from
// an ordinary message a specialist typed to the client.
async function handleControlCommand(
  sock: WASocket,
  chatId: string,
  text: string
): Promise<boolean> {
  const command = text.trim().toLowerCase();

  let reply: string;
  if (command === '!bot off all' || command === '!bot pause all') {
    globallyPaused = true;
    clearAllPendingReplies();
    reply = 'Бот на паузе для всех чатов.';
  } else if (command === '!bot on all' || command === '!bot resume all') {
    globallyPaused = false;
    reply = '🤖 Возобновлен для всех чатов.';
  } else if (command === '!bot off' || command === '!bot pause') {
    pausedChats.add(chatId);
    clearPendingReply(chatId);
    reply = '🤖 Пауза для этого чата.';
  } else if (command === '!bot on' || command === '!bot resume') {
    pausedChats.delete(chatId);
    reply = '🤖 Возобновлен для этого чата.';
  } else if (command === '!bot status') {
    reply = globallyPaused
      ? '🤖 Пауза для всех чатов.'
      : pausedChats.has(chatId)
        ? '🤖 Пауза для этого чата.'
        : '🤖 Активен.';
  } else {
    return false;
  }

  console.log(`[control] ${chatId}: ${command}`);
  await sock.sendMessage(chatId, { text: reply });
  return true;
}

// Buffers messages per chat and, once the user has been quiet for a few
// seconds, replies once to everything they sent in that burst.
function scheduleReply(sock: WASocket, chatId: string): void {
  const existingTimer = replyTimers.get(chatId);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  const timer = setTimeout(
    async () => {
      replyTimers.delete(chatId);
      const messages = pendingMessages.get(chatId) ?? [];
      pendingMessages.delete(chatId);
      if (messages.length === 0) return;

      const combinedText = messages.join('\n');

      try {
        await sock.presenceSubscribe(chatId).catch(() => {});
        await sock.sendPresenceUpdate('composing', chatId);

        const reply = await getReply(chatId, combinedText);
        await sleep(randomBetween(MIN_TYPING_DELAY_MS, MAX_TYPING_DELAY_MS));

        await sock.sendPresenceUpdate('paused', chatId);
        await sock.sendMessage(chatId, { text: reply });
      } catch (err) {
        console.error('Failed to generate reply:', err);
        await sock.sendMessage(chatId, {
          text: pickRandom(FALLBACK_ERROR_REPLIES),
        });
      }
    },
    randomBetween(MIN_REPLY_DELAY_MS, MAX_REPLY_DELAY_MS)
  );

  replyTimers.set(chatId, timer);
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  const sock = makeWASocket({
    auth: state,
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'close') {
      const shouldReconnect =
        (lastDisconnect?.error as Boom)?.output?.statusCode !==
        DisconnectReason.loggedOut;
      console.log(
        'connection closed due to',
        lastDisconnect?.error,
        ', reconnecting:',
        shouldReconnect
      );
      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, RECONNECT_DELAY_MS);
      }
    } else if (connection === 'open') {
      console.log('opened connection');
    }
  });

  sock.ev.on('messages.upsert', (event) => {
    if (event.type !== 'notify') return;
    for (const m of event.messages) {
      const chatId = m.key.remoteJid;
      if (!chatId) continue;

      const text = extractText(m.message);

      if (m.key.fromMe) {
        // Messages you send yourself can be "!bot off" / "!bot on" (etc.) to
        // mute/unmute without restarting the process. Any other message sent
        // from this number means a specialist is replying to the client
        // directly, so auto-pause the bot for that chat until "!bot on".
        if (text) {
          void (async () => {
            const wasCommand = await handleControlCommand(sock, chatId, text);
            if (!wasCommand && !isPaused(chatId)) {
              pausedChats.add(chatId);
              clearPendingReply(chatId);
              console.log(`[${chatId}] specialist took over — auto-paused`);
            }
          })();
        }
        continue;
      }

      if (!text) continue;

      if (isPaused(chatId)) {
        console.log(`[${chatId}] (paused, skipping) ${text}`);
        continue;
      }

      console.log(`[${chatId}] ${text}`);

      const buffered = pendingMessages.get(chatId) ?? [];
      buffered.push(text);
      pendingMessages.set(chatId, buffered);

      // Each new message pushes the reply out further, so a burst of
      // messages is answered once, a few seconds after the user stops typing.
      scheduleReply(sock, chatId);
    }
  });

  // Save credentials whenever they are updated
  sock.ev.on('creds.update', saveCreds);
}

connectToWhatsApp();
