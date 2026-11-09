// The replay engine: processes one M1 minute at a time through @forexedge/trading-sim,
// the backtester's rules. Pure: no I/O; the caller loads and saves the positions.
//
// Within one minute, in this order (as the backtester does on its bars):
//   1. closes requested before this minute fill at its open (a long at the bid, a
//      short at the ask): exit MANUAL
//   2. orders placed before this minute fill at its open (BUY at the ask, SELL at the
//      bid): an order is decided at a minute's close, so the next minute's open is the
//      first price it could get
//   3. stop loss / take profit on this minute's exit-side quotes, the fill minute
//      included: a gap at the open fills at the open, a touched level at the level,
//      SL first when both are inside the minute
import { closeQuote, entryFill, exitFill, exitQuotes, levelExit, markToMarketCents, Side } from '@forexedge/trading-sim';
import { PairContext } from '../history/replay-history';
import { moneySpec, realizedCents } from './booking';

export type EngineStatus = 'PENDING' | 'OPEN' | 'CLOSED' | 'CANCELLED';
export type EngineExitReason = 'SL' | 'TP' | 'MANUAL' | 'SESSION_END';

export interface EnginePosition {
  id: string;
  side: Side;
  units: number;
  status: EngineStatus;
  stopLossPoints: number | null;
  takeProfitPoints: number | null;
  entryTime: Date | null;
  entryPoints: number | null;
  exitRequestedAt: Date | null;
  exitTime: Date | null;
  exitPoints: number | null;
  exitReason: EngineExitReason | null;
  realizedCents: bigint | null;
}

export interface EngineMinute {
  time: Date;
  bid: { open: number; high: number; low: number; close: number };
  ask: { open: number; high: number; low: number; close: number };
}

export type EngineEvent =
  | { type: 'FILLED'; positionId: string; time: Date; points: number }
  | { type: 'CLOSED'; positionId: string; time: Date; points: number; reason: EngineExitReason; realizedCents: bigint };

const levelReason = { STOP_LOSS: 'SL', TAKE_PROFIT: 'TP' } as const;

// Processes one minute; mutates the positions it fills or closes and returns what happened
export function runMinute(positions: EnginePosition[], minute: EngineMinute, ctx: PairContext): EngineEvent[] {
  const events: EngineEvent[] = [];
  const close = (p: EnginePosition, points: number, reason: EngineExitReason) => {
    const cents = realizedCents(p.side, p.entryPoints as number, points, ctx, p.units);
    Object.assign(p, { status: 'CLOSED', exitTime: minute.time, exitPoints: points, exitReason: reason, realizedCents: cents });
    events.push({ type: 'CLOSED', positionId: p.id, time: minute.time, points, reason, realizedCents: cents });
  };

  // 1. Requested closes, at the open
  for (const p of positions) {
    if (p.status === 'OPEN' && p.exitRequestedAt !== null && p.exitRequestedAt < minute.time) {
      close(p, exitFill(p.side, minute), 'MANUAL');
    }
  }
  // 2. Pending orders, at the open
  for (const p of positions) {
    if (p.status === 'PENDING') {
      const points = entryFill(p.side, minute);
      Object.assign(p, { status: 'OPEN', entryTime: minute.time, entryPoints: points });
      events.push({ type: 'FILLED', positionId: p.id, time: minute.time, points });
    }
  }
  // 3. Stop loss / take profit on this minute's range
  for (const p of positions) {
    if (p.status !== 'OPEN') continue;
    const exit = levelExit(p.side, p.stopLossPoints ?? undefined, p.takeProfitPoints ?? undefined, exitQuotes(p.side, minute));
    if (exit) close(p, exit.points, levelReason[exit.reason]);
  }
  return events;
}

// Closes an open position at a minute's close (ending a session): a long at the bid, a short at the ask
export function closeAtMinuteClose(p: EnginePosition, minute: EngineMinute, ctx: PairContext, reason: EngineExitReason): EngineEvent {
  const points = closeQuote(p.side, minute);
  const cents = realizedCents(p.side, p.entryPoints as number, points, ctx, p.units);
  Object.assign(p, { status: 'CLOSED', exitTime: minute.time, exitPoints: points, exitReason: reason, realizedCents: cents });
  return { type: 'CLOSED', positionId: p.id, time: minute.time, points, reason, realizedCents: cents };
}

// What the open positions would net if closed at this minute's close (commission included)
export function unrealizedCents(positions: EnginePosition[], minute: EngineMinute, ctx: PairContext): bigint {
  return positions
    .filter((p) => p.status === 'OPEN')
    .reduce((sum, p) => sum + markToMarketCents(p.side, p.entryPoints as number, closeQuote(p.side, minute), moneySpec(ctx, p.units)), 0n);
}
