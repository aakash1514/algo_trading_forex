// Spread alerts: domain-service publishes one when an instrument's spread
// status changes (NORMAL <-> WIDE). Consumers (a future UI relay) type the
// payload with this interface, so producer and consumer can't drift apart.
// The WIDE rule itself lives in @forexedge/common (spread.ts).

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
