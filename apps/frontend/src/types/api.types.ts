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
  marginLevel: number;
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
  fromDate: string;
  toDate: string;
  status: BacktestStatus;
  progress: number;
  totalTrades: number | null;
  winRate: string | null;
  profitFactor: string | null;
  sharpeRatio: string | null;
  maxDrawdownPct: string | null;
  totalPnl: string | null;
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
}

export interface PositionUpdateEvent {
  positionId: string;
  pipPnl: number;
  unrealizedPnl: number;
  marginLevel: number;
}

export interface AccountUpdateEvent {
  equity: number;
  freeMargin: number;
  marginLevel: number;
}

export interface SignalUpdateEvent {
  instrument: string;
  signal: 'BUY' | 'SELL' | 'NEUTRAL';
  confidence: number;
  priceSignal: string;
  priceConfidence: number;
  sentiment: number;
  timestamp: string;
}