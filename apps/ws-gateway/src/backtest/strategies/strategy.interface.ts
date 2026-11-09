import type { Ohlc } from '@forexedge/trading-sim';

export type { Ohlc };

// A historical bar as the backtester sees it.
//   open/high/low/close  mid prices, for indicators (open/close are exact
//                        (bid + ask) / 2; high/low the mean of the bid and ask extremes)
//   bid/ask              the bar's own bid and ask OHLC in integer points
//                        (price x 10^priceDecimals), used for fills and SL/TP
export interface Candle {
  bucket: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  bid: Ohlc;
  ask: Ohlc;
  minutes: number; // M1 bars in this bar
}

// Contract specs from the DB (instruments.pip_size, historical_price_scale), never hardcoded
export interface StrategyContext {
  pipSize: number;
  priceDecimals: number;
}

// Emitted after bar `timestamp` closes; filled at the next bar's open
export interface Signal {
  timestamp: Date;
  action: 'BUY' | 'SELL' | 'CLOSE_LONG' | 'CLOSE_SHORT';
  lots: number;
  stopLoss?: number;   // price
  takeProfit?: number; // price
  reason: string;
}

export interface IStrategy {
  name: string;
  generate(candles: Candle[], parameters: Record<string, number>, context: StrategyContext): Signal[];
}

export interface Trade {
  entryTime: Date;
  exitTime: Date;
  action: 'BUY' | 'SELL';
  lots: number;
  entryPrice: number;
  exitPrice: number;
  entryPoints: number;  // entryPrice x 10^priceDecimals (exact)
  exitPoints: number;
  exitReason: 'SIGNAL' | 'STOP_LOSS' | 'TAKE_PROFIT' | 'END_OF_DATA';
  pnl: number;          // in pips
  commission: number;   // in pips
  netPnl: number;       // pnl - commission
}

// A trade with its money (@forexedge/trading-sim money.ts): position size and USD amounts
export interface MoneyTrade extends Trade {
  units: number;          // lots x lot_size
  grossUsd: number;
  commissionUsd: number;
  netUsd: number;         // grossUsd - commissionUsd
}
