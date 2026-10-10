// Every Kafka topic, its message type and parser. Producers type their payload
// with the interface; consumers parse with the parse* function.
//
// | Topic                 | Producer                                  | Consumers                                                        |
// |-----------------------|-------------------------------------------|------------------------------------------------------------------|
// | forex.ticks           | market-service (KafkaProducerService)     | market-service cache + DB writers, domain spread monitor,        |
// |                       |                                           | order-service tick processor, ws-gateway tick relay              |
// | forex.sessions        | domain-service session clock              | none (order-service computes sessions from the shared clock)     |
// | forex.spread-alerts   | domain-service spread monitor             | none yet (UI relay planned)                                      |
// | forex.calendar-events | domain-service economic calendar          | none yet (roadmap step 8)                                        |
// | orders.lifecycle      | order-service OrderService                | ws-gateway order relay                                           |
// | positions.updated     | order-service RealtimePublisher           | ws-gateway position relay                                        |
// | accounts.updated      | order-service RealtimePublisher           | ws-gateway account relay                                         |
import { checkRules, parseContract } from './contract';
import type { AccountUpdatedMessage, PositionsUpdatedMessage } from '../interfaces/realtime.interface';

// ─── forex.ticks ────────────────────────────────────────────────────────────
export const FOREX_TICKS_TOPIC = 'forex.ticks';

// A tick as it travels on Kafka: the timestamp is an ISO-8601 string (the
// producer's NormalizedTick holds a Date, which JSON serializes to a string).
export interface TickMessage {
  pair: string;        // EUR/USD
  instrument: string;  // EUR_USD (the Kafka key)
  bid: number;
  ask: number;
  mid: number;
  spread: number;
  timestamp: string;
  source: 'OANDA' | 'MOCK' | 'TWELVE_DATA';
}

export const parseTickMessage = (raw: string) => parseContract<TickMessage>(FOREX_TICKS_TOPIC, raw, {
  pair: 'string', instrument: 'string', bid: 'number', ask: 'number', mid: 'number', spread: 'number',
  timestamp: 'iso-date', source: ['OANDA', 'MOCK', 'TWELVE_DATA'],
});

// ─── forex.sessions ─────────────────────────────────────────────────────────
export const FOREX_SESSIONS_TOPIC = 'forex.sessions';
const SESSIONS = ['SYDNEY', 'TOKYO', 'LONDON', 'NEW_YORK'] as const;
export type ForexSessionName = (typeof SESSIONS)[number];

export interface SessionEventMessage {
  type: 'SESSION_OPEN' | 'SESSION_CLOSE';
  session: ForexSessionName;
  timestamp: string;
  activeSessions: ForexSessionName[];
}

export const parseSessionEventMessage = (raw: string) => parseContract<SessionEventMessage>(
  FOREX_SESSIONS_TOPIC, raw,
  { type: ['SESSION_OPEN', 'SESSION_CLOSE'], session: SESSIONS, timestamp: 'iso-date', activeSessions: 'string[]' },
  (o) => (o['activeSessions'] as string[]).every((s) => (SESSIONS as readonly string[]).includes(s))
    ? [] : ['"activeSessions" contains an unknown session'],
);

// ─── forex.spread-alerts ────────────────────────────────────────────────────
// Published when an instrument's spread status changes. The WIDE rule itself
// lives in @forexedge/common (spread.ts).
export const SPREAD_ALERTS_TOPIC = 'forex.spread-alerts';
export type SpreadStatus = 'NORMAL' | 'WIDE';

export interface SpreadAlertMessage {
  type: SpreadStatus;
  instrument: string;     // EUR_USD
  pair: string;           // EUR/USD
  currentSpread: number;  // ask - bid, price units
  avgSpread: number;      // instruments.avg_spread, price units
  ratio: number;          // currentSpread / avgSpread
  timestamp: string;      // ISO-8601, the tick's time
}

export const parseSpreadAlertMessage = (raw: string) => parseContract<SpreadAlertMessage>(SPREAD_ALERTS_TOPIC, raw, {
  type: ['NORMAL', 'WIDE'], instrument: 'string', pair: 'string',
  currentSpread: 'number', avgSpread: 'number', ratio: 'number', timestamp: 'iso-date',
});

// ─── forex.calendar-events ──────────────────────────────────────────────────
export const CALENDAR_EVENTS_TOPIC = 'forex.calendar-events';
const CALENDAR_EVENT_TYPES = ['CALENDAR_EVENT_APPROACHING', 'CALENDAR_EVENT_ACTIVE', 'CALENDAR_EVENT_PASSED'] as const;

export interface CalendarEventMessage {
  type: (typeof CALENDAR_EVENT_TYPES)[number];
  title: string;
  currency: string;
  impact: 'HIGH' | 'MEDIUM' | 'LOW';
  scheduledAt: string; // ISO-8601
  timestamp: string;   // ISO-8601, when published
}

export const parseCalendarEventMessage = (raw: string) => parseContract<CalendarEventMessage>(
  CALENDAR_EVENTS_TOPIC, raw,
  { type: CALENDAR_EVENT_TYPES, title: 'string', currency: 'string', impact: ['HIGH', 'MEDIUM', 'LOW'],
    scheduledAt: 'iso-date', timestamp: 'iso-date' },
);

// ─── orders.lifecycle ───────────────────────────────────────────────────────
export const ORDERS_LIFECYCLE_TOPIC = 'orders.lifecycle';
const ORDER_STATUSES = ['DRAFT', 'PENDING', 'SUBMITTED', 'OPEN', 'CLOSED', 'REJECTED', 'CANCELLED'] as const;

export interface OrderLifecycleMessage {
  orderId: string;
  userId: string;
  status: (typeof ORDER_STATUSES)[number];
  pair: string;
  direction: 'LONG' | 'SHORT';
  lots: number;
  executedPrice: number | null;
  timestamp: string;
}

export const parseOrderLifecycleMessage = (raw: string) => parseContract<OrderLifecycleMessage>(
  ORDERS_LIFECYCLE_TOPIC, raw,
  { orderId: 'string', userId: 'string', status: ORDER_STATUSES, pair: 'string', direction: ['LONG', 'SHORT'],
    lots: 'number', executedPrice: 'number|null', timestamp: 'iso-date' },
);

// ─── positions.updated ──────────────────────────────────────────────────────
export const POSITIONS_UPDATED_TOPIC = 'positions.updated';

export const parsePositionsUpdatedMessage = (raw: string) => parseContract<PositionsUpdatedMessage>(
  POSITIONS_UPDATED_TOPIC, raw,
  { type: ['PNL', 'SNAPSHOT'], userId: 'string' },
  (o) => o['type'] === 'PNL'
    ? checkRules(o, { positionId: 'string', currentPrice: 'number', pipPnl: 'number', unrealizedPnl: 'number' })
    : checkRules(o, { positions: 'object[]' }).concat(
      ((o['positions'] as Record<string, unknown>[]) ?? []).flatMap((p, i) => checkRules(p, {
        id: 'string', userId: 'string', pair: 'string', instrument: 'string', direction: ['LONG', 'SHORT'],
        lots: 'number', openPrice: 'number', unrealizedPnl: 'number', marginUsed: 'number', isOpen: 'boolean',
      }, `positions[${i}].`)),
    ),
);

// ─── accounts.updated ───────────────────────────────────────────────────────
export const ACCOUNTS_UPDATED_TOPIC = 'accounts.updated';

export const parseAccountUpdatedMessage = (raw: string) => parseContract<AccountUpdatedMessage>(
  ACCOUNTS_UPDATED_TOPIC, raw,
  { userId: 'string', summary: 'object' },
  (o) => checkRules(o['summary'] as Record<string, unknown>, {
    balance: 'number', marginUsed: 'number', unrealizedPnl: 'number', leverage: 'number',
    equity: 'number', freeMargin: 'number', marginLevel: 'number|null',
  }, 'summary.'),
);
