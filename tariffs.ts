import type Anthropic from '@anthropic-ai/sdk';

// Тарифы ОСАГО — постановление Кабинета Министров КР № 107 от 04.03.2022
// (в редакции № 114 от 04.03.2025). Тарифы ОСПП — утверждённые тарифы
// страховой премии обязательного страхования перевозчика перед пассажирами.
//
// Модель определяет только категории (тип ТС, стаж водителя, срок и т.д.),
// а подстановку коэффициентов и арифметику делает код — модель ошибается в
// перемножении коэффициентов, а клиенту называется конкретная сумма.

type Factor = { k: number; label: string };

const SALES_TAX: Factor = { k: 1.02, label: '2% налог с продаж' };

const somFormat = new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const numFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 6 });

const OSAGO_BASE_PREMIUM = 1680;

const OSAGO_VEHICLE: Record<string, Factor> = {
  car_engine_under_2000: {
    k: 1.0,
    label: 'легковой до 2000 куб. см или электромобиль до 50 кВт/ч',
  },
  car_engine_2001_3000: {
    k: 1.2,
    label: 'легковой 2001–3000 куб. см или электромобиль свыше 51 кВт/ч',
  },
  car_engine_over_3000: { k: 1.45, label: 'легковой свыше 3001 куб. см' },
  truck_under_12t: { k: 1.6, label: 'грузовой до 12 тонн' },
  truck_over_12t: { k: 2.0, label: 'грузовой более 12 тонн' },
  bus_up_to_16_seats: { k: 1.45, label: 'автобус до 16 пассажирских мест' },
  bus_over_16_seats: { k: 1.65, label: 'автобус свыше 16 пассажирских мест' },
  trolleybus: { k: 0.8, label: 'троллейбус' },
  motorcycle: { k: 0.45, label: 'мототранспорт' },
  trailer_or_special: {
    k: 0.45,
    label: 'прицеп, трактор или самоходная дорожно-строительная машина',
  },
};

const OSAGO_UNLIMITED_DRIVERS: Factor = {
  k: 1.6,
  label: 'неограниченное количество водителей или юридическое лицо',
};

const OSAGO_TERM: Record<string, Factor> = {
  days_5_to_15: { k: 0.2, label: 'от 5 до 15 дней' },
  days_16_to_1_month: { k: 0.3, label: 'от 16 дней до 1 месяца' },
  up_to_3_months: { k: 0.5, label: 'до 3 месяцев' },
  up_to_6_months: { k: 0.7, label: 'до 6 месяцев' },
  up_to_9_months: { k: 0.9, label: 'до 9 месяцев' },
  up_to_12_months: { k: 1.0, label: 'до 12 месяцев' },
};

const OSAGO_DIAGNOSTIC_CARD: Record<'yes' | 'no', Factor> = {
  yes: { k: 0.8, label: 'есть диагностическая карта' },
  no: { k: 1.0, label: 'нет диагностической карты' },
};

const OSAGO_UNREGISTERED: Factor = {
  k: 2.2,
  label: 'ТС не зарегистрировано в Кыргызстане',
};

const OSPP_LIMIT_PER_PASSENGER = 310_000;

const OSPP_ROAD_VEHICLE: Record<string, Factor> = {
  car_bus_minibus: { k: 1.2, label: 'легковой автомобиль, автобус или микроавтобус' },
  trolleybus: { k: 0.5, label: 'троллейбус' },
};

const OSPP_ROAD_TRIP: Record<string, Factor> = {
  city: { k: 0.8, label: 'внутригородские перевозки' },
  intercity_or_international: {
    k: 1.2,
    label: 'междугородние или международные перевозки',
  },
};

const OSPP_RAIL_TRIP: Record<string, Factor> = {
  domestic: { k: 0.8, label: 'внутренние перевозки' },
  international: { k: 1.2, label: 'международные перевозки' },
};

const NO_TAX_NOTE =
  'В базе знаний нет данных о том, применяется ли к этому виду транспорта налог с продаж, поэтому он в расчёт не включён.';

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function lookup(
  table: Record<string, Factor>,
  value: unknown,
  field: string
): Factor {
  if (typeof value === 'string') {
    const found = table[value];
    if (found) return found;
  }
  throw new Error(
    `Неизвестное значение поля ${field}: ${JSON.stringify(value)}. Допустимые значения: ${Object.keys(table).join(', ')}.`
  );
}

function positiveNumber(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }
  throw new Error(
    `Поле ${field} обязательно и должно быть положительным числом.`
  );
}

function nonNegativeNumber(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value;
  }
  throw new Error(`Поле ${field} обязательно и не может быть отрицательным.`);
}

// Возраст 25 лет относится к категории «до 25 лет включительно», стаж ровно
// 3 года — к категории «до 3 лет включительно». Границы определяются здесь,
// чтобы модель не решала, в какую категорию попадает водитель.
function osagoDriverFactor(input: Record<string, unknown>): Factor {
  if (input.driver_limit === 'unlimited_or_legal_entity') {
    return OSAGO_UNLIMITED_DRIVERS;
  }
  if (input.driver_limit !== 'limited') {
    throw new Error(
      `Неизвестное значение поля driver_limit: ${JSON.stringify(input.driver_limit)}. Допустимые значения: limited, unlimited_or_legal_entity.`
    );
  }

  const drivers = input.drivers;
  if (!Array.isArray(drivers) || drivers.length === 0) {
    throw new Error(
      'Поле drivers обязательно, когда driver_limit = limited: передай список водителей с их возрастом и стажем.'
    );
  }

  // При нескольких водителях применяется максимальный коэффициент.
  const factors = drivers.map((driver, index) => {
    const raw = (driver ?? {}) as Record<string, unknown>;
    const age = positiveNumber(raw.age, `drivers[${index}].age`);
    const experience = nonNegativeNumber(
      raw.experience_years,
      `drivers[${index}].experience_years`
    );
    const young = age <= 25;
    const inexperienced = experience <= 3;
    const k = young ? (inexperienced ? 1.4 : 1.3) : inexperienced ? 1.2 : 1.0;
    return {
      k,
      label: `водитель ${age} лет, стаж ${experience} лет`,
    };
  });

  return factors.reduce((worst, factor) => (factor.k > worst.k ? factor : worst));
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value === 'boolean') return value;
  throw new Error(`Поле ${field} обязательно и должно быть true или false.`);
}

function multiply(base: number, factors: Factor[]): number {
  return round2(factors.reduce((total, factor) => total * factor.k, base));
}

function formatFormula(
  head: string,
  factors: Factor[],
  premium: number
): string {
  const chain = factors
    .map((factor) => `${numFormat.format(factor.k)} (${factor.label})`)
    .join(' × ');
  return `${head} × ${chain} = ${somFormat.format(premium)} сом`;
}

type Calculation = { premium_som: number; period: string; formula: string };

function calculateOsago(input: Record<string, unknown>): Calculation {
  const hasCard = requiredBoolean(
    input.has_diagnostic_card,
    'has_diagnostic_card'
  );
  const registered = requiredBoolean(
    input.registered_in_kyrgyzstan,
    'registered_in_kyrgyzstan'
  );
  const bonusMalus =
    input.bonus_malus === undefined
      ? 1
      : positiveNumber(input.bonus_malus, 'bonus_malus');

  const factors: Factor[] = [
    lookup(OSAGO_VEHICLE, input.vehicle_type, 'vehicle_type'),
    osagoDriverFactor(input),
    { k: bonusMalus, label: 'бонус-малус' },
    OSAGO_DIAGNOSTIC_CARD[hasCard ? 'yes' : 'no'],
    lookup(OSAGO_TERM, input.term, 'term'),
  ];
  if (!registered) factors.push(OSAGO_UNREGISTERED);
  factors.push(SALES_TAX);

  const premium = multiply(OSAGO_BASE_PREMIUM, factors);
  return {
    premium_som: premium,
    period: 'за весь срок страхования',
    formula: formatFormula(
      `${numFormat.format(OSAGO_BASE_PREMIUM)} (базовая премия)`,
      factors,
      premium
    ),
  };
}

function calculateOsppRoad(input: Record<string, unknown>): Calculation {
  const seats = positiveNumber(input.seats, 'seats');
  const factors: Factor[] = [
    lookup(OSPP_ROAD_VEHICLE, input.vehicle_type, 'vehicle_type'),
    lookup(OSPP_ROAD_TRIP, input.trip_type, 'trip_type'),
    { k: seats, label: 'посадочных мест' },
    { k: OSPP_LIMIT_PER_PASSENGER, label: 'лимит на одного пассажира, сом' },
    SALES_TAX,
  ];
  const premium = multiply(0.00045, factors);
  return {
    premium_som: premium,
    period: 'в год',
    formula: formatFormula('0,045% (базовый тариф)', factors, premium),
  };
}

function calculateOsppAir(input: Record<string, unknown>): Calculation {
  const seats = positiveNumber(input.seats_occupied, 'seats_occupied');
  const factors: Factor[] = [
    { k: seats, label: 'фактически заполненных кресел' },
    { k: OSPP_LIMIT_PER_PASSENGER, label: 'лимит на одного пассажира, сом' },
  ];
  const premium = multiply(0.00007, factors);
  return {
    premium_som: premium,
    period: 'за один рейс',
    formula: formatFormula('0,007% (базовый тариф)', factors, premium),
  };
}

function calculateOsppRail(input: Record<string, unknown>): Calculation {
  const revenue = positiveNumber(
    input.annual_ticket_revenue_som,
    'annual_ticket_revenue_som'
  );
  const factors: Factor[] = [
    { k: revenue, label: 'годовой доход от продажи билетов, сом' },
    lookup(OSPP_RAIL_TRIP, input.trip_type, 'trip_type'),
  ];
  const premium = multiply(0.05, factors);
  return {
    premium_som: premium,
    period: 'в год',
    formula: formatFormula('5% (базовый тариф)', factors, premium),
  };
}

function calculateOsppWater(input: Record<string, unknown>): Calculation {
  const ticketPrice = positiveNumber(input.ticket_price_som, 'ticket_price_som');
  const passengers = positiveNumber(
    input.passengers_per_year,
    'passengers_per_year'
  );
  const factors: Factor[] = [
    { k: ticketPrice, label: 'стоимость билета, сом' },
    { k: passengers, label: 'фактически перевезённых пассажиров за год' },
  ];
  const premium = multiply(0.01, factors);
  return {
    premium_som: premium,
    period: 'за год страхования',
    formula: formatFormula('1% (базовый тариф)', factors, premium),
  };
}

export const PREMIUM_TOOLS: Anthropic.Tool[] = [
  {
    name: 'calculate_osago_premium',
    description:
      'Считает стоимость полиса ОСАГО по официальным тарифам. Вызывай этот инструмент всегда, когда нужна стоимость ОСАГО, и никогда не перемножай коэффициенты сам.',
    input_schema: {
      type: 'object',
      properties: {
        vehicle_type: {
          type: 'string',
          enum: Object.keys(OSAGO_VEHICLE),
          description: 'Тип транспортного средства.',
        },
        driver_limit: {
          type: 'string',
          enum: ['limited', 'unlimited_or_legal_entity'],
          description:
            'limited — полис на конкретных водителей. unlimited_or_legal_entity — количество водителей не ограничено или полис оформляется на юридическое лицо.',
        },
        drivers: {
          type: 'array',
          description:
            'Обязательно, когда driver_limit = limited: все водители, допущенные к управлению. Передавай возраст и стаж так, как их назвал клиент, не определяй категорию сам.',
          items: {
            type: 'object',
            properties: {
              age: { type: 'number', description: 'Возраст водителя в годах.' },
              experience_years: {
                type: 'number',
                description: 'Водительский стаж в годах.',
              },
            },
            required: ['age', 'experience_years'],
          },
        },
        has_diagnostic_card: {
          type: 'boolean',
          description: 'Есть ли у транспортного средства диагностическая карта.',
        },
        term: {
          type: 'string',
          enum: Object.keys(OSAGO_TERM),
          description: 'Срок страхования.',
        },
        registered_in_kyrgyzstan: {
          type: 'boolean',
          description:
            'Зарегистрировано ли транспортное средство в Кыргызстане. Если клиент об этом не говорил, передавай true.',
        },
        bonus_malus: {
          type: 'number',
          description:
            'Коэффициент бонус-малус. Оставляй пустым — по умолчанию применяется 1 (класс 3).',
        },
      },
      required: [
        'vehicle_type',
        'driver_limit',
        'has_diagnostic_card',
        'term',
        'registered_in_kyrgyzstan',
      ],
    },
  },
  {
    name: 'calculate_ospp_premium',
    description:
      'Считает стоимость полиса ОСПП (страхование перевозчика перед пассажирами) по официальным тарифам. Вызывай этот инструмент всегда, когда нужна стоимость ОСПП, и никогда не считай сумму сам.',
    input_schema: {
      type: 'object',
      properties: {
        transport_mode: {
          type: 'string',
          enum: ['road', 'air', 'rail', 'water'],
          description:
            'Вид транспорта: road — автомобильный, air — авиационный, rail — железнодорожный, water — водный.',
        },
        vehicle_type: {
          type: 'string',
          enum: Object.keys(OSPP_ROAD_VEHICLE),
          description: 'Только для road: вид транспортного средства.',
        },
        trip_type: {
          type: 'string',
          enum: ['city', 'intercity_or_international', 'domestic', 'international'],
          description:
            'Тип перевозки. Для road: city или intercity_or_international. Для rail: domestic или international.',
        },
        seats: {
          type: 'number',
          description: 'Только для road: количество посадочных мест.',
        },
        seats_occupied: {
          type: 'number',
          description:
            'Только для air: количество фактически заполненных пассажирских кресел на рейсе.',
        },
        annual_ticket_revenue_som: {
          type: 'number',
          description:
            'Только для rail: годовой доход перевозчика от продажи билетов по этому типу перевозок, в сомах.',
        },
        ticket_price_som: {
          type: 'number',
          description: 'Только для water: стоимость билета в сомах.',
        },
        passengers_per_year: {
          type: 'number',
          description:
            'Только для water: количество фактически перевезённых пассажиров за год страхования.',
        },
      },
      required: ['transport_mode'],
    },
  },
];

export function executePremiumTool(
  toolUse: Anthropic.ToolUseBlock
): Anthropic.ToolResultBlockParam {
  try {
    const input = (toolUse.input ?? {}) as Record<string, unknown>;
    const payload: Record<string, unknown> = {};

    if (toolUse.name === 'calculate_osago_premium') {
      Object.assign(payload, calculateOsago(input));
      if (input.bonus_malus === undefined) {
        payload.note =
          'Бонус-малус принят равным 1 (класс 3). Если у клиента были выплаты по предыдущим полисам ОСАГО, итоговая стоимость может отличаться.';
      }
    } else if (toolUse.name === 'calculate_ospp_premium') {
      switch (input.transport_mode) {
        case 'road':
          Object.assign(payload, calculateOsppRoad(input));
          break;
        case 'air':
          Object.assign(payload, calculateOsppAir(input));
          payload.note = NO_TAX_NOTE;
          break;
        case 'rail':
          Object.assign(payload, calculateOsppRail(input));
          payload.note = NO_TAX_NOTE;
          break;
        case 'water':
          Object.assign(payload, calculateOsppWater(input));
          payload.note = NO_TAX_NOTE;
          break;
        default:
          throw new Error(
            `Неизвестное значение поля transport_mode: ${JSON.stringify(input.transport_mode)}. Допустимые значения: road, air, rail, water.`
          );
      }
    } else {
      throw new Error(`Неизвестный инструмент: ${toolUse.name}.`);
    }

    return {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: JSON.stringify(payload),
    };
  } catch (err) {
    return {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content:
        err instanceof Error ? err.message : 'Не удалось выполнить расчёт.',
      is_error: true,
    };
  }
}
