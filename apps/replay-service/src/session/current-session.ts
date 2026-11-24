import { Not, Repository } from 'typeorm';
import { assertUserId } from '@forexedge/common';
import { ReplaySessionEntity } from '@forexedge/database';

// A user keeps several replay sessions (migration ReplaySessionsList). Their current one is
// the latest opened that isn't ENDED. Every write names its session; the current one only
// decides whether a write that changes the replay (play, step, speed, timeframe, orders,
// cancels, closes) is allowed: a tab still showing a session the user has since switched
// away from can't restart it behind their back, and never reaches the other session.
export const OTHER_SESSION_OPENED = 'This replay was paused because you opened another one';
export const NO_SUCH_SESSION = 'No such replay session, or it has ended';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

// The SessionLock key that serialises a user's play/open/create (session ids are UUIDs, so
// it can't collide with one)
export function userLockKey(userId: string): string {
  return `user:${userId}`;
}

// 'EUR/USD · 1m · 2022-03-16': pair · timeframe · start date (UTC); the migration's
// REPLAY_AUTO_TITLE_SQL builds the same string for older rows
export function autoTitle(pair: string, timeframe: string, startTime: Date): string {
  return `${pair} · ${timeframe} · ${startTime.toISOString().slice(0, 10)}`;
}

export function currentSession(sessions: Repository<ReplaySessionEntity>, userId: string): Promise<ReplaySessionEntity | null> {
  assertUserId(userId);
  return sessions.findOne({ where: { userId, status: Not('ENDED') }, order: { lastOpenedAt: 'DESC', id: 'DESC' } });
}

// refused is null exactly when session is set
export interface LiveSessionCheck {
  session: ReplaySessionEntity | null;
  refused: 'not-found' | 'not-current' | null;
}

// The user's session by id if it isn't ENDED (another user's id is simply not found), and,
// with requireCurrent, only while it is the user's current session. Run it under the
// session's lock, so the answer holds for the work that follows.
export async function liveSession(
  sessions: Repository<ReplaySessionEntity>, userId: string, sessionId: unknown, requireCurrent: boolean,
): Promise<LiveSessionCheck> {
  assertUserId(userId);
  if (!isSessionId(sessionId)) return { session: null, refused: 'not-found' };
  const session = await sessions.findOne({ where: { id: sessionId, userId, status: Not('ENDED') } });
  if (!session) return { session: null, refused: 'not-found' };
  if (requireCurrent && (await currentSession(sessions, userId))?.id !== session.id) return { session: null, refused: 'not-current' };
  return { session, refused: null };
}
