import { MAJOR_PAIRS, TIMEFRAMES, type Timeframe } from './constants';
import type { PauseReason, ReplayPosition, ReplaySession } from '../types/replay.types';

// Bar replay over the imported history (replay-service, step 6b-1). The limits mirror
// apps/replay-service/src/session/replay-window.ts and its DTOs; the server checks them
// again, these only let the page refuse an input before sending it.
export const REPLAY_PAIRS = MAJOR_PAIRS;
export const REPLAY_TIMEFRAMES = TIMEFRAMES;
export const DEFAULT_REPLAY_TIMEFRAME: Timeframe = '1h';
export const FIRST_START = '2010-01-01T00:00';
export const LAST_START = '2022-12-30T23:59';
export const DEFAULT_STARTING_BALANCE = 10_000;
export const MIN_STARTING_BALANCE = 100;
export const MAX_STARTING_BALANCE = 10_000_000;
export const MIN_LOTS = 0.01;
export const MAX_LOTS = 100;
// The history of all four pairs ends on this day (LAST_START)
export const END_OF_DATA_DAY = '30 Dec 2022';

export const REPLAY_SPEEDS = [
  { ms: 500, label: '0.5 s' },
  { ms: 1000, label: '1 s' },
  { ms: 2000, label: '2 s' },
] as const;
export type ReplaySpeedMs = (typeof REPLAY_SPEEDS)[number]['ms'];

// The next speed the replay offers: faster = a shorter time per bar. Null at either end
// (no wrap) and for a speed the list doesn't hold.
export function adjacentSpeed(currentMs: number, direction: 'faster' | 'slower'): ReplaySpeedMs | null {
  const i = REPLAY_SPEEDS.findIndex((s) => s.ms === currentMs);
  if (i < 0) return null;
  return REPLAY_SPEEDS[direction === 'faster' ? i - 1 : i + 1]?.ms ?? null;
}

export const PAUSE_MESSAGES: Record<PauseReason, string> = {
  USER: 'Paused',
  OTHER_TAB: 'Paused: replay opened in another tab or window',
  DISCONNECT: 'Paused: connection lost',
  SERVER_RESTART: 'Paused: server restarted',
  END_OF_DATA: `End of historical data (${END_OF_DATA_DAY})`,
};

// The status line under the controls
export function statusMessage(session: Pick<ReplaySession, 'status' | 'pauseReason' | 'endOfData'>): string {
  if (session.endOfData) return PAUSE_MESSAGES.END_OF_DATA;
  if (session.status === 'PLAYING') return 'Playing';
  return session.pauseReason ? PAUSE_MESSAGES[session.pauseReason] : 'Paused';
}

// Closed trades from the socket (the store) and from loaded pages, one per id (the
// store's copy wins: it is the newest), in the server's order: exit time, then id, newest first
export function mergeClosedTrades(fromStore: ReplayPosition[], fromPages: ReplayPosition[]): ReplayPosition[] {
  const byId = new Map<string, ReplayPosition>();
  for (const p of fromPages) byId.set(p.id, p);
  for (const p of fromStore) byId.set(p.id, p);
  return [...byId.values()]
    .filter((p) => p.status === 'CLOSED')
    .sort((a, b) => (b.exitTime ?? '').localeCompare(a.exitTime ?? '') || b.id.localeCompare(a.id));
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

// Date 'YYYY-MM-DD' and time 'HH:MM', both UTC -> 'YYYY-MM-DDTHH:MMZ' (the API's form),
// a real date between 2010-01-01 00:00 and 2022-12-30 23:59
export function startTimeFromInputs(date: string, time: string): Result<string> {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})$/.exec(time);
  if (!d || !t) return { ok: false, error: 'Enter a date (YYYY-MM-DD) and a time (HH:MM), in UTC' };
  const [year, month, day] = d.slice(1).map(Number);
  const [hour, minute] = t.slice(1).map(Number);
  const at = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (hour > 23 || minute > 59 || at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) {
    return { ok: false, error: `${date} ${time} is not a real date and time` };
  }
  const iso = `${date}T${time}`;
  if (iso < FIRST_START || iso > LAST_START) {
    return { ok: false, error: 'The start must be between 2010-01-01 00:00 and 2022-12-30 23:59 UTC' };
  }
  return { ok: true, value: `${iso}Z` };
}

// USD, 100 to 10,000,000, at most 2 decimals
export function startingBalanceFromInput(value: string): Result<number> {
  if (!/^\d+(\.\d{1,2})?$/.test(value.trim())) return { ok: false, error: 'Enter the starting balance in USD, e.g. 10000' };
  const amount = Number(value);
  if (amount < MIN_STARTING_BALANCE || amount > MAX_STARTING_BALANCE) {
    return { ok: false, error: 'The starting balance must be between $100 and $10,000,000' };
  }
  return { ok: true, value: amount };
}

// ── Exact decimals ──
// Prices and money arrive as decimal strings; they are compared and summed as integers
// (points, cents) so nothing passes through a binary float.

// '1.12186' at 5 decimals -> 112186; null when the text isn't a price at that scale
export function decimalToPoints(value: string, decimals: number): number | null {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m || (m[3] ?? '').length > decimals) return null;
  const points = Number(m[2] + (m[3] ?? '').padEnd(decimals, '0'));
  return m[1] === '-' ? -points : points;
}

export function decimalToCents(value: string): bigint {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!m) throw new Error(`Not a USD amount: ${value}`);
  const cents = BigInt(m[2]) * 100n + BigInt((m[3] ?? '').padEnd(2, '0'));
  return m[1] === '-' ? -cents : cents;
}

export function centsToDecimal(cents: bigint): string {
  const abs = cents < 0n ? -cents : cents;
  return `${cents < 0n ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

// '10000.00' -> '$10,000.00'; '-12.30' -> '-$12.30'; signed: '+$12.30'
export function formatUsd(value: string, signed = false): string {
  const cents = decimalToCents(value);
  const abs = cents < 0n ? -cents : cents;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sign = cents < 0n ? '-' : signed ? '+' : '';
  return `${sign}$${whole}.${String(abs % 100n).padStart(2, '0')}`;
}

// '2015-03-14T10:32:00.000Z' -> '2015-03-14 10:32 UTC'
export function formatReplayTime(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

// ── Orders ──

export interface OrderInputs {
  side: 'BUY' | 'SELL';
  lots: string;
  stopLoss: string;   // '' = none
  takeProfit: string; // '' = none
}

export interface OrderQuote {
  bid: string;        // the clock minute's close
  ask: string;
  decimals: number;
}

// The server's rules, checked before sending: lots 0.01-100 with at most 2 decimals; a
// level is a whole point at the pair's scale, on the right side of the price the
// position exits on (LONG: SL < bid < TP; SHORT: TP < ask < SL)
export function validateOrder(input: OrderInputs, quote: OrderQuote): Result<{
  side: 'BUY' | 'SELL'; lots: number; stopLoss?: number; takeProfit?: number;
}> {
  const lotsText = input.lots.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(lotsText) || Number(lotsText) < MIN_LOTS || Number(lotsText) > MAX_LOTS) {
    return { ok: false, error: 'Lots must be between 0.01 and 100, with at most 2 decimals' };
  }
  const exitName = input.side === 'BUY' ? 'bid' : 'ask';
  const exitText = input.side === 'BUY' ? quote.bid : quote.ask;
  const exit = decimalToPoints(exitText, quote.decimals) as number;
  const level = (name: 'Stop loss' | 'Take profit', text: string): Result<number | undefined> => {
    if (text.trim() === '') return { ok: true, value: undefined };
    const points = decimalToPoints(text, quote.decimals);
    if (points === null || points <= 0) {
      return { ok: false, error: `${name} must be a price with at most ${quote.decimals} decimals` };
    }
    const below = (name === 'Stop loss') === (input.side === 'BUY');
    if (below ? points >= exit : points <= exit) {
      return { ok: false, error: `${name} must be ${below ? 'below' : 'above'} the ${exitName} ${exitText}` };
    }
    return { ok: true, value: points };
  };
  const sl = level('Stop loss', input.stopLoss);
  if (!sl.ok) return sl;
  const tp = level('Take profit', input.takeProfit);
  if (!tp.ok) return tp;
  // the levels go as numbers (the API's form); the server checks they are whole points again
  return {
    ok: true,
    value: {
      side: input.side,
      lots: Number(lotsText),
      ...(sl.value === undefined ? {} : { stopLoss: Number(input.stopLoss.trim()) }),
      ...(tp.value === undefined ? {} : { takeProfit: Number(input.takeProfit.trim()) }),
    },
  };
}

// An RTK Query error -> plain words. The server's messages are already sentences
// ("Insufficient margin: need $112.04, free margin $50.00"); field names are spelled out.
export function replayErrorMessage(error: unknown): string {
  const e = error as { status?: unknown; data?: { message?: unknown } } | undefined;
  if (e?.status === 'FETCH_ERROR') return 'Replay service unreachable — is replay-service running?';
  if (e?.status === 'TIMEOUT_ERROR') return 'The replay service did not answer in time';
  const message = e?.data?.message;
  const text = Array.isArray(message) ? message.join('; ') : typeof message === 'string' ? message : null;
  if (!text) return 'The request failed';
  return text
    .replace(/\bstopLoss\b/g, 'Stop loss')
    .replace(/\btakeProfit\b/g, 'Take profit')
    .replace(/\bstartingBalance\b/g, 'Starting balance')
    .replace(/\bstartTime\b/g, 'Start time')
    .replace(/\blots\b/g, 'Lots');
}

// ── After ending ──

export interface EndSummary {
  startingBalance: string;
  finalBalance: string;
  netPnl: string;
  trades: number;
  tradesCapped: boolean; // the page only ever had the last 50 closed entries
}

export const RECENT_CLOSED_CAP = 50;

// Net P&L is exact (final - starting balance). Trades are the closed positions the page
// knows: the state's last 50 closed/cancelled entries, those closed while it was open,
// and those the end closed; when the state was at its cap there may have been more.
export function endSummary(
  session: ReplaySession, knownClosedIds: Iterable<string>, endedClosed: ReplayPosition[], stateWasCapped: boolean,
): EndSummary {
  const ids = new Set(knownClosedIds);
  for (const p of endedClosed) ids.add(p.id);
  return {
    startingBalance: session.startingBalance,
    finalBalance: session.balance,
    netPnl: centsToDecimal(decimalToCents(session.balance) - decimalToCents(session.startingBalance)),
    trades: ids.size,
    tradesCapped: stateWasCapped,
  };
}
