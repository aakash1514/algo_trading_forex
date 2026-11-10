// What replay-service (step 6b-1) sends, as the frontend reads it. Mirrors the views in
// apps/replay-service/src/session/*.view.ts and playback/replay-state.service.ts.
// Prices and money are exact decimal strings (EUR/USD '1.12186', USD '10000.00').

export const PAUSE_REASONS = ['USER', 'OTHER_TAB', 'DISCONNECT', 'SERVER_RESTART', 'END_OF_DATA'] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];

export interface ReplaySession {
  id: string;
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
}

export interface ReplayAccount {
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

// The socket's 'state': everything as of the clock
export interface ReplayState {
  session: ReplaySession;
  account: ReplayAccount;
  priceDecimals: number;
  bars: ReplayBar[];            // completed bars before the current one (up to 500)
  currentBar: ReplayBar;
  positions: ReplayPosition[];  // pending and open, then the latest 50 closed/cancelled
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
