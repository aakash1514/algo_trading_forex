// What replay-service (step 6b-1) sends, as the frontend reads it. Mirrors the views in
// apps/replay-service/src/session/*.view.ts and playback/replay-state.service.ts.
// Prices and money are exact decimal strings (EUR/USD '1.12186', USD '10000.00').

export const PAUSE_REASONS = ['USER', 'OTHER_TAB', 'DISCONNECT', 'SERVER_RESTART', 'END_OF_DATA'] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];

export interface ReplaySession {
  id: string;
  title: string;               // the user's title, or the auto name 'EUR/USD · 1m · 2022-03-16'
  instrument: string;          // 'EUR_USD'
  startTime: string;
  clockTime: string;           // the last processed M1 minute (UTC)
  status: 'PLAYING' | 'PAUSED' | 'ENDED';
  pauseReason: PauseReason | null;
  speedMs: number;
  timeframe: string;
  startingBalance: string;
  balance: string;
  endOfData: boolean;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
  lastOpenedAt: string;
}

// Every account and position event names its session: a tab ignores another session's
export interface ReplayAccount {
  sessionId: string;
  clockTime: string;
  balance: string;
  unrealizedPnlUsd: string;
  equity: string;
  marginUsed: string;
  freeMargin: string;
  openPositions: number;
  pendingOrders: number;
}

export interface Quote {
  open: string;
  high: string;
  low: string;
  close: string;
}

export interface ReplayBar {
  time: string;                // the bar's start (UTC)
  lastMinute: string | null;   // the latest minute it holds (the current bar only)
  minutes: number;
  bid: Quote;
  ask: Quote;
}

export interface ReplayPosition {
  id: string;
  sessionId: string;
  side: 'BUY' | 'SELL';
  lots: string;
  units: number;
  status: 'PENDING' | 'OPEN' | 'CLOSED' | 'CANCELLED';
  placedAt: string;
  stopLoss: string | null;
  takeProfit: string | null;
  marginUsd: string;
  entryTime: string | null;
  entryPrice: string | null;
  exitRequestedAt: string | null;
  exitTime: string | null;
  exitPrice: string | null;
  exitReason: 'SL' | 'TP' | 'MANUAL' | 'SESSION_END' | null;
  realizedPnlUsd: string | null;
  cancelledAt: string | null;
}

// An economic calendar event the replay clock has reached (replay-service
// history/replay-calendar.ts): never one after the clock
export interface CalendarEvent {
  id: string;
  time: string;                 // when it was scheduled (UTC)
  barTime: string;              // the start of the session-timeframe bar that holds it
  title: string;                // the source's wording
  currency: string;
  impact: 'HIGH' | 'MEDIUM';
  source: string;               // FOMC, ECB or the third-party export
  timeSource: 'official' | 'expected' | 'third_party';
  actual: string | null;
  forecast: string | null;
  previous: string | null;
}

export interface ReplayCalendar {
  covered: boolean;             // false: no calendar data for this period
  events: CalendarEvent[];      // from the first bar shown to the clock, oldest first
}

// The socket's 'calendar' after a step: the events the step passed
export interface CalendarMessage {
  sessionId: string;
  timeframe: string;
  clockTime: string;
  events: CalendarEvent[];
}

// The socket's 'state': everything as of the clock
export interface ReplayState {
  session: ReplaySession;
  account: ReplayAccount;
  priceDecimals: number;
  bars: ReplayBar[];            // completed bars before the current one (up to 500)
  currentBar: ReplayBar;
  positions: ReplayPosition[];  // pending and open, then the latest 50 closed/cancelled
  calendar: ReplayCalendar;
}

export interface BarEvent {
  sessionId: string;
  timeframe: string;
  clockTime: string;
  bar: ReplayBar;
}

export interface EndOfDataEvent {
  sessionId: string;
  clockTime: string;
  message: string;
}

export interface EndedSession {
  session: ReplaySession;
  closed: ReplayPosition[];     // closed at the clock (SESSION_END)
  cancelled: ReplayPosition[];  // pending orders that never filled
}

// GET /sessions/:id/trades: closed trades newest first (exit time, then id), 20 a page
export interface TradesPage {
  trades: ReplayPosition[];
  nextCursor: string | null;    // null on the last page
}

// GET /sessions/:id/stats (replay-service session/replay-stats.ts): from every closed
// trade of the session; null where undefined (no trades, no wins, no losses)
export interface ReplayStats {
  trades: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRatePct: string | null;
  netPnlUsd: string;
  grossProfitUsd: string;
  grossLossUsd: string;
  profitFactor: string | null;  // null without a loss
  averageWinUsd: string | null;
  averageLossUsd: string | null;
  largestWinUsd: string | null;
  largestLossUsd: string | null;
  maxDrawdownUsd: string;       // on the closed-trade balance
  maxDrawdownPct: string;
}

export interface OrderResult {
  position: ReplayPosition;
  account: ReplayAccount;
}

export interface CreateSessionRequest {
  instrument: string;
  startTime: string;            // 'YYYY-MM-DDTHH:MMZ'
  timeframe: string;
  startingBalance: number;
}

export interface PlaceOrderRequest {
  side: 'BUY' | 'SELL';
  lots: number;
  stopLoss?: number;
  takeProfit?: number;
}

export type CommandAck<T = unknown> = { ok: true; result: T } | { ok: false; error: string };

// The result of a 'step' (replay-service playback.service.ts StepResult)
export interface StepResult {
  session: ReplaySession;
  minutes: number;              // M1 minutes processed
  endOfData: boolean;
}
