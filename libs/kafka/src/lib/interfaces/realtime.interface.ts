// Real-time user updates: order-service publishes them to Kafka, ws-gateway
// relays them to the user's Socket.IO room.

export const REALTIME_TOPICS = {
  ORDERS_LIFECYCLE: 'orders.lifecycle',
  POSITIONS_UPDATED: 'positions.updated',
  ACCOUNTS_UPDATED: 'accounts.updated',
} as const;

// Socket.IO event names emitted to `user:<id>` rooms.
// Mirrored in apps/frontend/src/lib/constants.ts (SOCKET_EVENTS); keep in sync.
export const SOCKET_EVENTS = {
  ORDER_UPDATE: 'order:update',
  POSITION_UPDATE: 'position:update',
  POSITIONS_SNAPSHOT: 'positions:snapshot',
  ACCOUNT_UPDATE: 'account:update',
} as const;

// Tick-driven P&L for one open position (throttled to ~1/s per position).
export interface PositionPnlMessage {
  type: 'PNL';
  userId: string;
  positionId: string;
  currentPrice: number;
  pipPnl: number;
  unrealizedPnl: number;
}

// Full list of the user's open positions, sent after an open or close.
export interface PositionsSnapshotMessage {
  type: 'SNAPSHOT';
  userId: string;
  positions: object[];
}

export type PositionsUpdatedMessage = PositionPnlMessage | PositionsSnapshotMessage;

export interface AccountSummaryPayload {
  balance: number;
  marginUsed: number;
  unrealizedPnl: number;
  leverage: number;
  equity: number;
  freeMargin: number;
  marginLevel: number | null;
}

export interface AccountUpdatedMessage {
  userId: string;
  summary: AccountSummaryPayload;
}
