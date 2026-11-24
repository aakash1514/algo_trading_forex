import { ReplayPositionEntity } from '@forexedge/database';
import { centsToDecimal, decimalToCents } from '../engine/booking';
import { toEngine } from '../engine/position-mapping';
import { EngineMinute, unrealizedCents } from '../engine/replay-engine';
import { PairContext } from '../history/replay-history';

// The replay account at the clock minute's close, in USD (exact decimal strings).
//   equity      = balance + what the open positions would net if closed at the clock
//                 minute's close (a long at the bid, a short at the ask, commission
//                 deducted, USD/JPY converted at that price)
//   marginUsed  = margin reserved by the open positions and the pending orders
//   freeMargin  = equity - marginUsed
export interface AccountView {
  sessionId: string;   // every socket event names its session
  clockTime: string;
  balance: string;
  unrealizedPnlUsd: string;
  equity: string;
  marginUsed: string;
  freeMargin: string;
  openPositions: number;
  pendingOrders: number;
}

export interface AccountCents {
  balance: bigint;
  unrealized: bigint;
  equity: bigint;
  marginUsed: bigint;
}

export function accountCents(
  balance: string, positions: ReplayPositionEntity[], clockMinute: EngineMinute, ctx: PairContext,
): AccountCents {
  const balanceCents = decimalToCents(balance);
  const unrealized = unrealizedCents(positions.map(toEngine), clockMinute, ctx);
  const marginUsed = positions.filter((p) => p.status === 'OPEN' || p.status === 'PENDING')
    .reduce((sum, p) => sum + decimalToCents(p.marginUsd), 0n);
  return { balance: balanceCents, unrealized, equity: balanceCents + unrealized, marginUsed };
}

export function accountView(
  sessionId: string, balance: string, positions: ReplayPositionEntity[], clockMinute: EngineMinute, ctx: PairContext,
): AccountView {
  const a = accountCents(balance, positions, clockMinute, ctx);
  return {
    sessionId,
    clockTime: clockMinute.time.toISOString(),
    balance: centsToDecimal(a.balance),
    unrealizedPnlUsd: centsToDecimal(a.unrealized),
    equity: centsToDecimal(a.equity),
    marginUsed: centsToDecimal(a.marginUsed),
    freeMargin: centsToDecimal(a.equity - a.marginUsed),
    openPositions: positions.filter((p) => p.status === 'OPEN').length,
    pendingOrders: positions.filter((p) => p.status === 'PENDING').length,
  };
}
