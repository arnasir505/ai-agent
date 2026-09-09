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
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  throw new Error('ANTHROPIC_API_KEY environment variable is required');
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const MODEL = 'claude-haiku-4-5';

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

const BASE_SYSTEM_PROMPT =
  'You are a helpful, friendly assistant chatting over WhatsApp. Keep replies short and conversational (a few sentences) unless the user asks for more detail. ' +
  'Write in plain text only. Never use any formatting: no bold, no italics, no asterisks, no underscores, no Markdown headings, no backticks. For lists use plain "- " or "1. " lines with no other symbols.';

const SYSTEM_PROMPT = businessInfo
  ? `${BASE_SYSTEM_PROMPT}\n\nUse the following business information to answer customer questions. If the answer isn't in this info, say you'll check and get back to them — don't make it up.\n\n${businessInfo}`
  : BASE_SYSTEM_PROMPT;

const MAX_HISTORY_MESSAGES = 20;

// Wait this long after the user goes quiet before replying, so bursts of
// messages get answered once instead of once per message.
const MIN_REPLY_DELAY_MS = 5_000;
const MAX_REPLY_DELAY_MS = 10_000;

// Extra "typing" pause before actually sending, so replies don't appear instantly.
const MIN_TYPING_DELAY_MS = 1_500;
const MAX_TYPING_DELAY_MS = 4_000;

const FALLBACK_EMPTY_REPLIES = [
  'Hmm, not sure what to say to that.',
  "Sorry, I couldn't come up with a reply to that.",
  "I'm drawing a blank on that one.",
];

const FALLBACK_ERROR_REPLIES = [
  'Sorry, I ran into an error processing that.',
  'Ugh, something went wrong on my end there.',
  'Hit a snag trying to reply — can you say that again?',
];

const conversations = new Map<string, Anthropic.MessageParam[]>();
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

async function getReply(chatId: string, userText: string): Promise<string> {
  const history = conversations.get(chatId) ?? [];
  history.push({ role: 'user', content: userText });

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    // Slightly higher temperature so replies (and especially near-duplicate
    // messages) don't come back worded identically every time.
    temperature: 1,
    messages: history,
  });

  const textBlock = response.content.find(
    (block): block is Anthropic.TextBlock => block.type === 'text'
  );
  const reply = stripFormatting((textBlock?.text ?? '').trim()).trim();

  history.push({
    role: 'assistant',
    content: reply || pickRandom(FALLBACK_EMPTY_REPLIES),
  });
  conversations.set(chatId, history.slice(-MAX_HISTORY_MESSAGES));

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
async function handleControlCommand(
  sock: WASocket,
  chatId: string,
  text: string
): Promise<void> {
  const command = text.trim().toLowerCase();

  let reply: string;
  if (command === '!bot off all' || command === '!bot pause all') {
    globallyPaused = true;
    clearAllPendingReplies();
    reply = '🤖 Paused for all chats.';
  } else if (command === '!bot on all' || command === '!bot resume all') {
    globallyPaused = false;
    reply = '🤖 Resumed for all chats.';
  } else if (command === '!bot off' || command === '!bot pause') {
    pausedChats.add(chatId);
    clearPendingReply(chatId);
    reply = '🤖 Paused for this chat.';
  } else if (command === '!bot on' || command === '!bot resume') {
    pausedChats.delete(chatId);
    reply = '🤖 Resumed for this chat.';
  } else if (command === '!bot status') {
    reply = globallyPaused
      ? '🤖 Paused for all chats.'
      : pausedChats.has(chatId)
        ? '🤖 Paused for this chat.'
        : '🤖 Active.';
  } else {
    return;
  }

  console.log(`[control] ${chatId}: ${command}`);
  await sock.sendMessage(chatId, { text: reply });
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
        connectToWhatsApp();
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
        // mute/unmute without restarting the process.
        if (text) void handleControlCommand(sock, chatId, text);
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
