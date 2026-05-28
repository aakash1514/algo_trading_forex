export interface Candle {
  bucket: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  tick_count: number;
}

export interface Signal {
  timestamp: Date;
  action: 'BUY' | 'SELL' | 'CLOSE_LONG' | 'CLOSE_SHORT';
  lots: number;
  stopLoss?: number;
  takeProfit?: number;
  reason: string;
}

export interface IStrategy {
  name: string;
  generate(candles: Candle[], parameters: Record<string, number>): Signal[];
}

export interface Trade {
  entryTime: Date;
  exitTime: Date;
  action: 'BUY' | 'SELL';
  lots: number;
  entryPrice: number;
  exitPrice: number;
  pnl: number;          // in pips
  commission: number;   // in pips
  netPnl: number;       // pnl - commission
}