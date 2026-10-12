import type { AuthUser, AccountSummary, Position, Order, SignalUpdateEvent } from './api.types';

export interface AuthState {
  user: AuthUser | null;
  accessToken: string | null; // in memory only
  isAuthenticated: boolean;
  sessionRestored: boolean;   // false until the app-load refresh attempt resolves
}

export interface MarketState {
  prices: Record<string, {
    bid: number;
    ask: number;
    spread: number;
    timestamp: string;
    source: string;
  }>;
  activePair: string;
}

export interface PositionsState {
  items: Record<string, Position>;
}

export interface OrdersState {
  recentUpdates: Array<{
    orderId: string;
    status: string;
    previousStatus: string;
    timestamp: string;
  }>;
}

export interface AccountState {
  summary: AccountSummary | null;
}

export interface SignalsState {
  signals: Record<string, SignalUpdateEvent>;
}