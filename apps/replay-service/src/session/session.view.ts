import { ReplaySessionEntity } from '@forexedge/database';
import { pairToInstrument } from './replay-window';

// A session as the API and the socket send it. endOfData is derived: the clock is on
// the pair's last imported minute.
export interface SessionView {
  id: string;
  instrument: string;     // 'EUR_USD'
  startTime: string;
  clockTime: string;      // the last processed M1 minute
  status: string;
  pauseReason: string | null; // why a PAUSED session is paused; null while PLAYING
  speedMs: number;
  timeframe: string;
  startingBalance: string;
  balance: string;
  endOfData: boolean;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
}

export function sessionView(session: ReplaySessionEntity, lastTime: Date): SessionView {
  return {
    id: session.id,
    instrument: pairToInstrument(session.pair),
    startTime: session.startTime.toISOString(),
    clockTime: session.clockTime.toISOString(),
    status: session.status,
    pauseReason: session.pauseReason,
    speedMs: session.speedMs,
    timeframe: session.timeframe,
    startingBalance: session.startingBalance,
    balance: session.balance,
    endOfData: session.clockTime.getTime() >= lastTime.getTime(),
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
    endedAt: session.endedAt ? session.endedAt.toISOString() : null,
  };
}
