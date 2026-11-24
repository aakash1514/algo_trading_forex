import { BadRequestException } from '@nestjs/common';
import { ReplaySessionEntity } from '@forexedge/database';
import { centsToDecimal, decimalToCents } from '../engine/booking';
import { autoTitle } from './current-session';
import { pairToInstrument } from './replay-window';

export const SESSIONS_PAGE_SIZE = 20;

// Tables whose rows belong to one replay session (an FK to replay_sessions). Deleting a
// session deletes their rows first, in the same transaction; a DB test fails when a table
// with such an FK is missing here (future indicators, drawings, ...).
export const REPLAY_SESSION_CHILD_TABLES = ['replay_positions'] as const;

// One row of "My replays"
export interface SessionListItem {
  id: string;
  title: string;
  instrument: string;        // 'EUR_USD'
  timeframe: string;
  status: string;            // PLAYING, PAUSED or ENDED
  current: boolean;          // the user's current session (latest opened, not ENDED)
  startTime: string;
  clockTime: string;         // the replay time it stopped at
  netPnlUsd: string;         // balance - starting balance: closed trades only (open positions not marked)
  lastOpenedAt: string;
  endedAt: string | null;
}

export interface SessionsPage {
  sessions: SessionListItem[];   // last opened first: last_opened_at DESC, id DESC
  nextCursor: string | null;     // null on the last page
}

export function sessionListItem(s: ReplaySessionEntity, currentId: string | null): SessionListItem {
  return {
    id: s.id,
    title: s.title ?? autoTitle(s.pair, s.timeframe, s.startTime),
    instrument: pairToInstrument(s.pair),
    timeframe: s.timeframe,
    status: s.status,
    current: s.id === currentId,
    startTime: s.startTime.toISOString(),
    clockTime: s.clockTime.toISOString(),
    netPnlUsd: centsToDecimal(decimalToCents(s.balance) - decimalToCents(s.startingBalance)),
    lastOpenedAt: s.lastOpenedAt.toISOString(),
    endedAt: s.endedAt ? s.endedAt.toISOString() : null,
  };
}

// The keyset cursor: the last row's last_opened_at with Postgres's full microseconds (a
// JS Date keeps only milliseconds, which would repeat or skip rows at a page boundary)
// and its id
interface Cursor { t: string; id: string }

const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The SQL text of a cursor time: timestamptz in UTC with microseconds
export const CURSOR_TIME_SQL = `to_char(s.last_opened_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export function encodeListCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

export function decodeListCursor(raw: string): Cursor {
  let c: unknown;
  try {
    c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new BadRequestException('Invalid cursor');
  }
  const { t, id } = (c ?? {}) as Partial<Cursor>;
  if (typeof t !== 'string' || typeof id !== 'string' || !CURSOR_TIME.test(t) || !UUID.test(id)
      || Number.isNaN(Date.parse(t))) {
    throw new BadRequestException('Invalid cursor');
  }
  return { t, id };
}
