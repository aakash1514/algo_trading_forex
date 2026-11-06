// Auth
export interface LoginRequest {
  email: string;
  password: string;
}

export interface RegisterRequest {
  email: string;
  username: string;
  password: string;
  firstName: string;
  lastName: string;
}

export interface AuthUser {
  id: string;
  email: string;
  username: string;
  role: 'ADMIN' | 'TRADER' | 'ANALYST' | 'READ_ONLY';
  firstName: string;
  lastName: string;
}

export interface AuthResponse {
  accessToken: string;
  user: AuthUser;
}

// Market
export interface TickPrice {
  pair: string;
  instrument: string;
  bid: number;
  ask: number;
  mid: number;
  spread: number;
  timestamp: string;
  source: string;
}

export interface Candle {
  bucket?: string;
  time?: number | string;
  open: number | string;
  high: number | string;
  low: number | string;
  close: number | string;
  tick_count?: string;
  avg_spread?: string;
}

// Orders
export type OrderDirection = 'LONG' | 'SHORT';
export type OrderType = 'MARKET' | 'LIMIT' | 'STOP';
export type OrderStatus =
  | 'PENDING'
  | 'VALIDATED'
  | 'ACCEPTED'
  | 'FILLED'
  | 'PARTIALLY_FILLED'
  | 'CANCELLED'
  | 'REJECTED';

export interface Order {
  id: string;
  instrument: string;
  direction: OrderDirection;
  orderType: OrderType;
  lots: number;
  status: OrderStatus;
  filledPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  createdAt: string;
}

export interface CreateOrderRequest {
  instrument: string;
  direction: OrderDirection;
  orderType: OrderType;
  lots: number;
  stopLoss?: number;
  takeProfit?: number;
}

// Positions
export interface Position {
  id: string;
  orderId: string;
  instrument: string;
  direction: OrderDirection;
  lots: number;
  openPrice: number;
  currentPrice: number;
  pipPnl: number;
  unrealizedPnl: number;
  marginUsed: number;
  openedAt: string;
}

// Account
export interface AccountSummary {
  balance: number;
  equity: number;
  marginUsed: number;
  freeMargin: number;
  marginLevel: number | null; // null when no margin is in use
  unrealizedPnl: number;
}

// Domain
export interface SessionInfo {
  session: 'SYDNEY' | 'TOKYO' | 'LONDON' | 'NEW_YORK' | 'CLOSED';
  open: boolean;
  nextEvent: string;
  nextEventTime: string;
}

export interface PipValueResponse {
  pair: string;
  lots: number;
  pipValue: number;
  accountCurrency: string;
}

export interface MarginResponse {
  required: number;
  leverage: number;
}

// Backtesting
export type BacktestStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';

export interface BacktestRun {
  id: string;
  strategyName: string;
  instrument: string;
  timeframe: string;
  fromDate: string;           // the From day, 00:00 UTC
  toDate: string;             // the To day, 00:00 UTC (inclusive: the whole day is tested)
  initialCapital: string;     // USD
  lots: string;
  status: BacktestStatus;
  progress: number;
  totalTrades: number | null;
  winRate: string | null;       // 0-100; null without trades
  profitFactor: string | null;  // null without a losing trade
  sharpeRatio: string | null;   // null when it can't be computed
  maxDrawdownPct: string | null;
  totalPnl: string | null;      // net pips
  totalPnlUsd: string | null;   // net USD
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface BacktestMetrics {
  totalTrades: number;
  winRate: number;
  profitFactor: number;
  sharpeRatio: number;
  maxDrawdown: number;
  netProfit: number;
  totalReturn: number;
}

// WebSocket events
export interface TickEvent {
  bid: number;
  ask: number;
  spread: number;
  timestamp: string;
  source: string; // 'MOCK' (simulated) | 'TWELVE_DATA' | 'OANDA'
}

// GET /api/domain/calendar: events from official calendars (domain-service economic-calendar)
export interface CalendarEvent {
  id: string;
  title: string;          // the source's own wording
  currency: string;
  impact: 'HIGH' | 'MEDIUM' | 'LOW'; // ForexEdge classification, not source data
  scheduledAt: string;    // the release moment, UTC
  // expected: the source publishes no time (FOMC); third_party: published by a third-party export
  timeSource: 'official' | 'expected' | 'third_party';
  source: string;         // a key of CALENDAR_SOURCES (lib/calendar.ts)
  forecast: string | null;
  previous: string | null;
  actual: string | null;
  createdAt: string;
}

// GET /api/market/feed/status (market-service stream/feed-status.ts)
export type FeedState = 'off' | 'connected' | 'degraded' | 'down';
export interface FeedStatus {
  feed: 'none' | 'mock';
  source: string | null;
  simulated: boolean;
  state: FeedState;
  since: string;
  lastTickAt: string | null;
  lastError: string | null;
}

// Socket payloads (see SOCKET_EVENTS in lib/constants.ts)
export interface PositionUpdateEvent {
  positionId: string;
  currentPrice: number;
  pipPnl: number;
  unrealizedPnl: number;
}

export type PositionsSnapshotEvent = Position[];

export type AccountUpdateEvent = AccountSummary;

export interface SignalUpdateEvent {
  instrument: string;
  signal: 'BUY' | 'SELL' | 'NEUTRAL';
  confidence: number;
  priceSignal: string;
  priceConfidence: number;
  sentiment: number;
  timestamp: string;
}
// ML service (roadmap step 4): historical walk-forward test results, not live signals
export interface MlScores {
  n: number;
  correct: number;
  accuracy: number;
  accuracy_ci95: [number, number];
  balanced_accuracy: number;
  log_loss: number | null;
  brier: number | null;
}

export type MlModelKey = 'lstm' | 'logistic' | 'majority' | 'persistence' | 'anti_persistence';
export type MlBaseline = Exclude<MlModelKey, 'lstm'>;

export interface MlPooledTest {
  pair: string; // 'EUR/USD'
  baseline: MlBaseline;
  n: number;
  lstm_correct: number;
  baseline_correct: number;
  lstm_only: number;
  baseline_only: number;
  p_raw: number;
  p_holm: number;
  lstm_accuracy: number;
  baseline_accuracy: number;
  lstm_ci95: [number, number];
  baseline_ci95: [number, number];
  beats: boolean;
  significantly_worse: boolean;
}

export interface MlEvaluation {
  target: string;
  disclaimer: string;
  generatedAt: string;
  commit: string;
  rule: string;
  pooled: MlPooledTest[];
  perYear: { instrument: string; testYear: number; chosenLstm: string; test: Record<MlModelKey, MlScores> }[];
  breakEven: { pair: string; mean_move_pips: number; mean_spread_pips: number; break_even_accuracy: number }[];
  sqlCheck: { pairYears: number; allMatch: boolean };
}

export interface MlPrediction {
  barTime: string;
  targetBarTime: string;
  pUp: number;
  predicted: 'UP' | 'DOWN';
  actual: 'UP' | 'DOWN' | 'FLAT';
  scored: boolean;
  model: string;
  bar: { open: number; high: number; low: number; close: number };
}

export interface MlPredictions {
  instrument: string;
  timeframe: string;
  from: string;
  to: string;
  target: string;
  disclaimer: string;
  predictions: MlPrediction[];
}

// Research agent (roadmap step 5): POST /api/research/ask. Every value is a string exactly as the
// verifier checked it; display it unchanged.
export type ResearchReportType = 'answer' | 'refusal' | 'not_in_data' | 'could_not_verify';
export type ResearchClaimUnit = 'price' | 'pips' | 'pct' | 'usd' | 'count' | 'ratio' | 'p' | 'lots' | 'param';

export interface ResearchClaim {
  text: string;
  value: string;
  unit: ResearchClaimUnit;
  tool_call_id: string;
}

export interface ResearchToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  result_truncated: string;
}

export interface ResearchDataRange {
  tool: string;
  pair: string | null;
  timeframe: string | null;
  from_date: string | null;
  to_date: string | null;
  year: number | null;
  month: number | null;
  run_id: string | null;
}

export interface ResearchReport {
  type: ResearchReportType;
  answer: string;
  claims: ResearchClaim[];
  tool_calls: ResearchToolCall[];
  data_ranges: ResearchDataRange[];
  disclaimer: string;
  verification: { ok: boolean; failures: string[]; claims_checked: number; numbers_checked: number };
}
