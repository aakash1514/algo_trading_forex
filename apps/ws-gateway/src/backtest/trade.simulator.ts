import { Candle, Ohlc, Signal, StrategyContext, Trade } from './strategies/strategy.interface';

// Commission: 0.7 pips per side (round trip = 1.4 pips) — realistic ECN cost.
// The spread is not modelled: every fill uses the bar's own bid or ask.
const COMMISSION_PIPS = 0.7;

type Side = 'BUY' | 'SELL';

interface OpenTrade {
  action: Side;
  lots: number;
  entryTime: Date;
  entryPoints: number;
  stopLoss?: number;   // points
  takeProfit?: number; // points
}

// Bar-by-bar simulation on real bid/ask bars, all prices in integer points.
//
//   Fills    A signal is known only after its bar closes, so it fills at the NEXT
//            bar's open: BUY at the ask open, SELL at the bid open; a long closes at
//            the bid open, a short at the ask open. Closes run before opens, so a
//            CLOSE_SHORT + BUY pair reverses at the same open.
//   SL/TP    Checked on every bar from the fill bar on, against the fill bar's range
//            after its open: a long on the bid, a short on the ask. A bar that opens
//            beyond a level fills at that open (gap); a level touched inside the bar
//            fills at the level. If SL and TP are both inside one bar, SL wins (the
//            order within a bar is unknown, so assume the worse one).
//   End      A trade still open after the last bar closes at that bar's close.
//   P&L      In pips: point difference / points per pip (pip_size x 10^decimals).
export class TradeSimulator {
  constructor(private readonly context: StrategyContext) {
    const pipPoints = this.pipPoints;
    if (!Number.isInteger(pipPoints) || pipPoints < 1) {
      throw new Error(`pip size ${context.pipSize} is not a whole number of points at ${context.priceDecimals} decimals`);
    }
  }

  get pipPoints(): number {
    return Math.round(this.context.pipSize * 10 ** this.context.priceDecimals * 1e6) / 1e6;
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
          trades.push(this.close(open, (open.action === 'BUY' ? bar.bid : bar.ask).open, bar.bucket, 'SIGNAL'));
          open = null;
        } else if (!open && isOpen(signal)) {
          const side = signal.action as Side;
          open = {
            action: side,
            lots: signal.lots,
            entryTime: bar.bucket,
            entryPoints: side === 'BUY' ? bar.ask.open : bar.bid.open,
            stopLoss: this.toPoints(signal.stopLoss),
            takeProfit: this.toPoints(signal.takeProfit),
          };
        }
      }
      pending = [];

      // 2. Stop loss / take profit on this bar's range, the fill bar included
      if (open) {
        const exit = this.levelExit(open, open.action === 'BUY' ? bar.bid : bar.ask);
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
      trades.push(this.close(open, (open.action === 'BUY' ? last.bid : last.ask).close, last.bucket, 'END_OF_DATA'));
    }
    return trades;
  }

  private levelExit(trade: OpenTrade, quotes: Ohlc): { points: number; reason: Trade['exitReason'] } | null {
    const { stopLoss: sl, takeProfit: tp } = trade;
    if (trade.action === 'BUY') {
      if (sl !== undefined && quotes.open <= sl) return { points: quotes.open, reason: 'STOP_LOSS' };
      if (tp !== undefined && quotes.open >= tp) return { points: quotes.open, reason: 'TAKE_PROFIT' };
      if (sl !== undefined && quotes.low <= sl) return { points: sl, reason: 'STOP_LOSS' };
      if (tp !== undefined && quotes.high >= tp) return { points: tp, reason: 'TAKE_PROFIT' };
    } else {
      if (sl !== undefined && quotes.open >= sl) return { points: quotes.open, reason: 'STOP_LOSS' };
      if (tp !== undefined && quotes.open <= tp) return { points: quotes.open, reason: 'TAKE_PROFIT' };
      if (sl !== undefined && quotes.high >= sl) return { points: sl, reason: 'STOP_LOSS' };
      if (tp !== undefined && quotes.low <= tp) return { points: tp, reason: 'TAKE_PROFIT' };
    }
    return null;
  }

  // Strategy levels are prices; rounded once to the nearest point
  private toPoints(price: number | undefined): number | undefined {
    return price === undefined ? undefined : Math.round(price * 10 ** this.context.priceDecimals);
  }

  private close(open: OpenTrade, exitPoints: number, exitTime: Date, reason: Trade['exitReason']): Trade {
    const direction = open.action === 'BUY' ? 1 : -1;
    const pnlPips = ((exitPoints - open.entryPoints) * direction) / this.pipPoints;
    const commissionPips = COMMISSION_PIPS * 2; // round trip
    const price = (points: number) => points / 10 ** this.context.priceDecimals;
    return {
      entryTime: open.entryTime,
      exitTime,
      action: open.action,
      lots: open.lots,
      entryPrice: price(open.entryPoints),
      exitPrice: price(exitPoints),
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
