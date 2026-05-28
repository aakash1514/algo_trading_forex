import { Candle, Signal, Trade } from './strategies/strategy.interface';

// Commission: 0.7 pips per side (round trip = 1.4 pips) — realistic ECN cost
const COMMISSION_PIPS = 0.7;
// Standard spread applied on entry: 1 pip for major pairs
const SPREAD_PIPS = 1.0;
const PIP_SIZE = 0.0001;

export class TradeSimulator {

  simulate(candles: Candle[], signals: Signal[], instrument: string): Trade[] {
    const trades: Trade[] = [];
    const pipSize = instrument.includes('JPY') ? 0.01 : PIP_SIZE;

    let openTrade: Partial<Trade> & { stopLoss?: number; takeProfit?: number } | null = null;

    for (const signal of signals) {
      // Find the candle at or after the signal timestamp — no lookahead bias
      const candle = this.findCandle(candles, signal.timestamp);
      if (!candle) continue;

      if (signal.action === 'BUY' && !openTrade) {
        // Apply spread on entry — buyer pays the ask (mid + half spread)
        const entryPrice = candle.close + (SPREAD_PIPS * pipSize) / 2;
        openTrade = {
          entryTime: candle.bucket,
          action: 'BUY',
          lots: signal.lots,
          entryPrice,
          stopLoss: signal.stopLoss,
          takeProfit: signal.takeProfit,
        };
      }

      if (signal.action === 'SELL' && !openTrade) {
        // Seller receives the bid (mid - half spread)
        const entryPrice = candle.close - (SPREAD_PIPS * pipSize) / 2;
        openTrade = {
          entryTime: candle.bucket,
          action: 'SELL',
          lots: signal.lots,
          entryPrice,
          stopLoss: signal.stopLoss,
          takeProfit: signal.takeProfit,
        };
      }

      if ((signal.action === 'CLOSE_LONG' || signal.action === 'CLOSE_SHORT') && openTrade) {
        const exitPrice = candle.close;
        trades.push(this.closeTrade(openTrade, exitPrice, candle.bucket, pipSize));
        openTrade = null;
      }

      // Check stop loss / take profit on each candle if trade is open
      if (openTrade) {
        const sl = openTrade.stopLoss;
        const tp = openTrade.takeProfit;

        if (openTrade.action === 'BUY') {
          if (sl && candle.low <= sl) {
            trades.push(this.closeTrade(openTrade, sl, candle.bucket, pipSize));
            openTrade = null;
          } else if (tp && candle.high >= tp) {
            trades.push(this.closeTrade(openTrade, tp, candle.bucket, pipSize));
            openTrade = null;
          }
        }

        if (openTrade?.action === 'SELL') {
          if (sl && candle.high >= sl) {
            trades.push(this.closeTrade(openTrade, sl, candle.bucket, pipSize));
            openTrade = null;
          } else if (tp && candle.low <= tp) {
            trades.push(this.closeTrade(openTrade, tp, candle.bucket, pipSize));
            openTrade = null;
          }
        }
      }
    }

    // Close any open trade at end of data
    if (openTrade && candles.length > 0) {
      const lastCandle = candles[candles.length - 1];
      trades.push(this.closeTrade(openTrade, lastCandle.close, lastCandle.bucket, pipSize));
    }

    return trades;
  }

  private closeTrade(
    open: Partial<Trade> & { stopLoss?: number; takeProfit?: number },
    exitPrice: number,
    exitTime: Date,
    pipSize: number,
  ): Trade {
    const direction = open.action === 'BUY' ? 1 : -1;
    const priceDiff = (exitPrice - open.entryPrice!) * direction;
    const pnlPips = priceDiff / pipSize;
    const commissionPips = COMMISSION_PIPS * 2; // round trip
    const netPnl = pnlPips - commissionPips;

    return {
      entryTime: open.entryTime!,
      exitTime,
      action: open.action as 'BUY' | 'SELL',
      lots: open.lots!,
      entryPrice: open.entryPrice!,
      exitPrice,
      pnl: parseFloat(pnlPips.toFixed(2)),
      commission: parseFloat(commissionPips.toFixed(2)),
      netPnl: parseFloat(netPnl.toFixed(2)),
    };
  }

  private findCandle(candles: Candle[], timestamp: Date): Candle | undefined {
    // Find first candle at or after signal timestamp — no lookahead
    return candles.find((c) => new Date(c.bucket) >= new Date(timestamp));
  }
}