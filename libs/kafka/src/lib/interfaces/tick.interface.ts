export interface RawTick {
  type: 'PRICE';
  instrument: string;       // e.g. "EUR_USD"
  time: string;             // ISO 8601
  tradeable: boolean;
  bids: Array<{ price: string; liquidity: number }>;
  asks: Array<{ price: string; liquidity: number }>;
}

export interface NormalizedTick {
  pair: string;             // e.g. "EUR/USD"
  instrument: string;       // e.g. "EUR_USD" (Kafka key)
  bid: number;
  ask: number;
  mid: number;              // (bid + ask) / 2
  spread: number;           // ask - bid
  timestamp: Date;
  source: 'OANDA' | 'MOCK' | 'TWELVE_DATA';
}