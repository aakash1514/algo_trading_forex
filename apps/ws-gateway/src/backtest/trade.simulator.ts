import {
  closeQuote, COMMISSION_PIPS_PER_SIDE, entryFill, exitFill, exitQuotes, levelExit, pipPoints, priceToPoints, Side,
} from '@forexedge/trading-sim';
import { Candle, Signal, StrategyContext, Trade } from './strategies/strategy.interface';

interface OpenTrade {
  action: Side;
  lots: number;
  entryTime: Date;
  entryPoints: number;
  stopLoss?: number;   // points
  takeProfit?: number; // points
}

// Bar-by-bar simulation on real bid/ask bars, all prices in integer points. The
// fill, SL/TP and end-of-data rules are @forexedge/trading-sim's (shared with
// replay); this class runs them over a strategy's signals.
//
//   Signals  A signal is known only after its bar closes, so it fills at the NEXT
//            bar's open. Closes run before opens, so a CLOSE_SHORT + BUY pair
//            reverses at the same open. One trade is open at a time.
//   SL/TP    Checked on every bar from the fill bar on (trading-sim levelExit).
//   End      A trade still open after the last bar closes at that bar's close.
//   P&L      In pips: point difference / points per pip (pip_size x 10^decimals).
export class TradeSimulator {
  readonly pipPoints: number;

  constructor(private readonly context: StrategyContext) {
    this.pipPoints = pipPoints(context.pipSize, context.priceDecimals);
  }

  simulate(candles: Candle[], signals: Signal[]): Trade[] {
    const trades: Trade[] = [];
    const byBar = new Map<number, Signal[]>();
    for (const signal of signals) {
      const key = new Date(signal.timestamp).getTime();
      byBar.set(key, [...(byBar.get(key) ?? []), signal]);
    }

    let open: OpenTrade | null = null;
    let pending: Signal[] = [];

    for (const bar of candles) {
      // 1. Signals from the previous bar fill at this bar's open (closes first)
      for (const signal of [...pending].sort((a, b) => Number(isOpen(a)) - Number(isOpen(b)))) {
        if (open && ((signal.action === 'CLOSE_LONG' && open.action === 'BUY') ||
                     (signal.action === 'CLOSE_SHORT' && open.action === 'SELL'))) {
          // A long sells at the bid, a short buys back at the ask
          trades.push(this.close(open, exitFill(open.action, bar), bar.bucket, 'SIGNAL'));
          open = null;
        } else if (!open && isOpen(signal)) {
          const side = signal.action as Side;
          open = {
            action: side,
            lots: signal.lots,
            entryTime: bar.bucket,
            entryPoints: entryFill(side, bar),
            stopLoss: this.toPoints(signal.stopLoss),
            takeProfit: this.toPoints(signal.takeProfit),
          };
        }
      }
      pending = [];

      // 2. Stop loss / take profit on this bar's range, the fill bar included
      if (open) {
        const exit = levelExit(open.action, open.stopLoss, open.takeProfit, exitQuotes(open.action, bar));
        if (exit) {
          trades.push(this.close(open, exit.points, bar.bucket, exit.reason));
          open = null;
        }
      }

      // 3. This bar's signals wait for the next bar's open
      pending = byBar.get(bar.bucket.getTime()) ?? [];
    }

    if (open && candles.length > 0) {
      const last = candles[candles.length - 1];
      trades.push(this.close(open, closeQuote(open.action, last), last.bucket, 'END_OF_DATA'));
    }
    return trades;
  }

  // Strategy levels are prices; rounded once to the nearest point
  private toPoints(price: number | undefined): number | undefined {
    return price === undefined ? undefined : priceToPoints(price, this.context.priceDecimals);
  }

  private close(open: OpenTrade, exitPoints: number, exitTime: Date, reason: Trade['exitReason']): Trade {
    const direction = open.action === 'BUY' ? 1 : -1;
    const pnlPips = ((exitPoints - open.entryPoints) * direction) / this.pipPoints;
    const commissionPips = COMMISSION_PIPS_PER_SIDE * 2; // round trip
    const price = (points: number) => points / 10 ** this.context.priceDecimals;
    return {
      entryTime: open.entryTime,
      exitTime,
      action: open.action,
      lots: open.lots,
      entryPrice: price(open.entryPoints),
      exitPrice: price(exitPoints),
      entryPoints: open.entryPoints,
      exitPoints,
      exitReason: reason,
      pnl: round2(pnlPips),
      commission: round2(commissionPips),
      netPnl: round2(pnlPips - commissionPips),
    };
  }
}

function isOpen(signal: Signal): boolean {
  return signal.action === 'BUY' || signal.action === 'SELL';
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
