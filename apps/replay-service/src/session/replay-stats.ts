// Statistics of a replay session's closed trades, computed from every closed trade (in
// close order: exit_time, then id). Money is integer cents from the stored net P&L
// (commission included); every ratio rounds half away from zero to 2 decimals, as
// Postgres round(numeric, 2) does (tools/replay-verify/src/stats-sql.ts recomputes all
// of it in SQL). Null where a value is undefined (no trades, no wins, no losses).
import { centsToDecimal } from '../engine/booking';

export interface ClosedTrade {
  pnlCents: bigint;
}

export interface ReplayStats {
  trades: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRatePct: string | null;
  netPnlUsd: string;
  grossProfitUsd: string;
  grossLossUsd: string;          // <= 0
  profitFactor: string | null;   // null when there is no loss
  averageWinUsd: string | null;
  averageLossUsd: string | null; // < 0
  largestWinUsd: string | null;
  largestLossUsd: string | null; // < 0
  // On the closed-trade balance (starting balance plus each close): the largest fall
  // from a running peak that starts at the starting balance; open positions are ignored
  maxDrawdownUsd: string;
  maxDrawdownPct: string;
}

// n / d rounded half away from zero (d > 0)
export function roundHalfAway(n: bigint, d: bigint): bigint {
  const abs = n < 0n ? -n : n;
  const q = abs / d + (2n * (abs % d) >= d ? 1n : 0n);
  return n < 0n ? -q : q;
}

// Hundredths -> '12.34' (the same layout as cents -> USD)
const hundredths = centsToDecimal;

// `trades` in close order (exit_time, id)
export function replayStats(trades: ClosedTrade[], startingBalanceCents: bigint): ReplayStats {
  let wins = 0;
  let losses = 0;
  let grossProfit = 0n;
  let grossLoss = 0n;
  let largestWin: bigint | null = null;
  let largestLoss: bigint | null = null;
  let balance = startingBalanceCents;
  let peak = startingBalanceCents;
  let maxDrawdown = 0n;
  // The largest drawdown fraction, kept as (fall, peak) and compared by cross-multiplying
  let maxFall = 0n;
  let maxFallPeak = 1n;

  for (const { pnlCents } of trades) {
    if (pnlCents > 0n) {
      wins += 1;
      grossProfit += pnlCents;
      if (largestWin === null || pnlCents > largestWin) largestWin = pnlCents;
    } else if (pnlCents < 0n) {
      losses += 1;
      grossLoss += pnlCents;
      if (largestLoss === null || pnlCents < largestLoss) largestLoss = pnlCents;
    }
    balance += pnlCents;
    if (balance > peak) peak = balance;
    const fall = peak - balance;
    if (fall > maxDrawdown) maxDrawdown = fall;
    if (peak > 0n && fall * maxFallPeak > maxFall * peak) {
      maxFall = fall;
      maxFallPeak = peak;
    }
  }

  const count = trades.length;
  return {
    trades: count,
    wins,
    losses,
    breakeven: count - wins - losses,
    winRatePct: count === 0 ? null : hundredths(roundHalfAway(BigInt(wins) * 10_000n, BigInt(count))),
    netPnlUsd: centsToDecimal(grossProfit + grossLoss),
    grossProfitUsd: centsToDecimal(grossProfit),
    grossLossUsd: centsToDecimal(grossLoss),
    profitFactor: grossLoss === 0n ? null : hundredths(roundHalfAway(grossProfit * 100n, -grossLoss)),
    averageWinUsd: wins === 0 ? null : centsToDecimal(roundHalfAway(grossProfit, BigInt(wins))),
    averageLossUsd: losses === 0 ? null : centsToDecimal(roundHalfAway(grossLoss, BigInt(losses))),
    largestWinUsd: largestWin === null ? null : centsToDecimal(largestWin),
    largestLossUsd: largestLoss === null ? null : centsToDecimal(largestLoss),
    maxDrawdownUsd: centsToDecimal(maxDrawdown),
    maxDrawdownPct: hundredths(roundHalfAway(maxFall * 10_000n, maxFallPeak)),
  };
}
