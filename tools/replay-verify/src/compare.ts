import { VerifiedTrade } from './verified-report';

// A position as replay-service reported it (REST/socket views)
export interface ReplayedTrade {
  side: 'BUY' | 'SELL';
  entryTime: string;   // ISO, the M1 minute it filled on
  entryPoints: number;
  exitTime: string;    // ISO, the M1 minute it closed on
  exitPoints: number;
  exitReason: 'SL' | 'TP' | 'MANUAL' | 'SESSION_END';
  netCents: number;
}

export interface Mismatch {
  trade: number;
  field: string;
  verified: string;
  replayed: string;
}

export interface Comparison {
  ok: boolean;
  compared: number;
  verifiedNetCents: number;
  replayedNetCents: number;
  mismatches: Mismatch[];
  errors: string[];
}

// The backtester's exit reasons and replay's: a strategy signal is a manual close in
// replay, and the end of the data is the end of the session
const REASON: Record<VerifiedTrade['exit'], ReplayedTrade['exitReason']> = {
  SIGNAL: 'MANUAL', END_OF_DATA: 'SESSION_END', STOP_LOSS: 'SL', TAKE_PROFIT: 'TP',
};

// The H1 bar (UTC) an M1 minute belongs to, 'YYYY-MM-DDTHH:00'
export function hourOf(iso: string): string {
  return `${new Date(iso).toISOString().slice(0, 13)}:00`;
}

// Trade by trade, in order: side, the H1 bar of the entry and exit, the fill prices
// in points, the exit reason and the net USD in cents; then the totals. Empty input on
// either side is an error, never a match.
export function compareTrades(verified: VerifiedTrade[], replayed: ReplayedTrade[]): Comparison {
  const mismatches: Mismatch[] = [];
  const errors: string[] = [];
  if (verified.length === 0) errors.push('no verified trades');
  if (replayed.length === 0) errors.push('no replayed trades');
  if (verified.length !== replayed.length) errors.push(`${verified.length} verified trades, ${replayed.length} replayed`);
  const n = Math.min(verified.length, replayed.length);
  for (let i = 0; i < n; i++) {
    const v = verified[i];
    const r = replayed[i];
    const check = (field: string, a: string | number, b: string | number) => {
      if (String(a) !== String(b)) mismatches.push({ trade: i + 1, field, verified: String(a), replayed: String(b) });
    };
    check('side', v.side, r.side);
    check('entry bar', v.entryHour, hourOf(r.entryTime));
    check('entry points', v.entryPoints, r.entryPoints);
    check('exit bar', v.exitHour, hourOf(r.exitTime));
    check('exit points', v.exitPoints, r.exitPoints);
    check('exit reason', REASON[v.exit], r.exitReason);
    check('net cents', v.netCents, r.netCents);
  }
  const verifiedNetCents = verified.reduce((s, t) => s + t.netCents, 0);
  const replayedNetCents = replayed.reduce((s, t) => s + t.netCents, 0);
  if (verifiedNetCents !== replayedNetCents) {
    mismatches.push({ trade: 0, field: 'total net cents', verified: String(verifiedNetCents), replayed: String(replayedNetCents) });
  }
  return {
    ok: errors.length === 0 && mismatches.length === 0, compared: n, verifiedNetCents, replayedNetCents, mismatches, errors,
  };
}
