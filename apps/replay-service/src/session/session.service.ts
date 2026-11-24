import {
  BadRequestException, ConflictException, Injectable, NotFoundException, UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Not, Repository } from 'typeorm';
import { assertUserId } from '@forexedge/common';
import { HistoricalDataError, ReplayPositionEntity, ReplaySessionEntity } from '@forexedge/database';
import { centsToDecimal } from '../engine/booking';
import { applyEngine, toEngine } from '../engine/position-mapping';
import { closeAtMinuteClose } from '../engine/replay-engine';
import { SessionLock } from '../engine/session-lock';
import { PairContextService } from '../history/pair-context.service';
import { firstMinuteAtOrAfter, lastMinuteAtOrBefore, minuteAt } from '../history/replay-history';
import { autoTitle, currentSession, NO_SUCH_SESSION } from './current-session';
import { CreateSessionDto } from './dto/create-session.dto';
import { positionView, PositionView } from './position.view';
import { DEFAULT_STARTING_BALANCE, instrumentToPair, parseStartTime } from './replay-window';
import {
  CURSOR_TIME_SQL, decodeListCursor, encodeListCursor, REPLAY_SESSION_CHILD_TABLES, SessionListItem, sessionListItem,
  SESSIONS_PAGE_SIZE, SessionsPage,
} from './session-list';
import { sessionView, SessionView } from './session.view';
import { normalizeTitle } from './title';

export interface EndedSession {
  session: SessionView;
  closed: PositionView[];     // closed at the clock minute's close (SESSION_END)
  cancelled: PositionView[];  // pending orders that never filled
}

// Replay sessions. A user keeps several; the current one is the latest opened that isn't
// ENDED (current-session.ts). Every query is scoped by the owner, so another user's
// session is simply not found.
@Injectable()
export class ReplaySessionService {
  constructor(
    @InjectRepository(ReplaySessionEntity) private readonly sessions: Repository<ReplaySessionEntity>,
    private readonly dataSource: DataSource,
    private readonly pairs: PairContextService,
    private readonly lock: SessionLock,
  ) {}

  // A new session, PAUSED and the latest opened (so the user's current one). Run it through
  // PlaybackService.createAndOpen, which pauses a playing session first.
  async create(userId: string, dto: CreateSessionDto): Promise<SessionView> {
    assertUserId(userId);
    const pair = instrumentToPair(dto.instrument);
    const start = parseStartTime(dto.startTime);
    const ctx = await this.pairs.get(pair).catch((err) => {
      throw err instanceof HistoricalDataError ? new UnprocessableEntityException(err.message) : err;
    });

    // The clock starts on the first traded minute at or after the start (a weekend
    // start begins at the next open); after the last imported minute, on that minute.
    const clock = (await firstMinuteAtOrAfter(this.dataSource, pair, start))
      ?? (await lastMinuteAtOrBefore(this.dataSource, pair, start));
    if (!clock) throw new UnprocessableEntityException(`No historical data for ${pair}`);

    const balance = centsToDecimal(BigInt(Math.round((dto.startingBalance ?? DEFAULT_STARTING_BALANCE) * 100)));
    const saved = await this.sessions.save(this.sessions.create({
      userId, pair, startTime: start, clockTime: clock, status: 'PAUSED', pauseReason: null, speedMs: 1000,
      timeframe: dto.timeframe, startingBalance: balance, balance, endedAt: null,
      title: this.titleOrAuto(dto.title, pair, dto.timeframe, start), lastOpenedAt: new Date(),
    }));
    return sessionView(await this.sessions.findOneByOrFail({ id: saved.id, userId }), ctx.lastTime);
  }

  // The user's current session (read only)
  async getActive(userId: string): Promise<SessionView> {
    const session = await currentSession(this.sessions, userId);
    if (!session) throw new NotFoundException('No active replay session');
    return sessionView(session, (await this.pairs.get(session.pair)).lastTime);
  }

  // "My replays": every session of the user (any status), last opened first, 20 a page.
  // Keyset on (last_opened_at DESC, id DESC): the id breaks a tie, and opening a session
  // while the user pages moves it to the top of a fresh first page.
  async list(userId: string, cursor?: string): Promise<SessionsPage> {
    assertUserId(userId);
    const after = cursor ? decodeListCursor(cursor) : null;
    const { entities, raw } = await this.sessions.createQueryBuilder('s')
      .addSelect(CURSOR_TIME_SQL, 'cursor_time')
      .where('s.userId = :userId', { userId })
      .andWhere(after ? '(s.lastOpenedAt, s.id) < (CAST(:t AS timestamptz), CAST(:id AS uuid))' : 'TRUE', after ?? {})
      .orderBy('s.lastOpenedAt', 'DESC')
      .addOrderBy('s.id', 'DESC')
      .limit(SESSIONS_PAGE_SIZE + 1)
      .getRawAndEntities<{ s_id: string; cursor_time: string }>();
    const currentId = (await currentSession(this.sessions, userId))?.id ?? null;
    const page = entities.slice(0, SESSIONS_PAGE_SIZE);
    const last = page.at(-1);
    const lastTime = last && raw.find((r) => r.s_id === last.id)?.cursor_time;
    return {
      sessions: page.map((s) => sessionListItem(s, currentId)),
      nextCursor: entities.length > SESSIONS_PAGE_SIZE && last && lastTime ? encodeListCursor({ t: lastTime, id: last.id }) : null,
    };
  }

  // Renames one of the user's sessions (any status). A title by title.ts's rules; empty or
  // null gives the auto name again.
  async rename(userId: string, sessionId: string, title: unknown): Promise<SessionListItem> {
    assertUserId(userId);
    const session = await this.sessions.findOne({ where: { id: sessionId, userId } });
    if (!session) throw new NotFoundException('No such replay session');
    const next = this.titleOrAuto(title, session.pair, session.timeframe, session.startTime);
    await this.sessions.update({ id: session.id, userId }, { title: next });
    const currentId = (await currentSession(this.sessions, userId))?.id ?? null;
    return sessionListItem(await this.sessions.findOneByOrFail({ id: session.id, userId }), currentId);
  }

  // Deletes one of the user's ENDED sessions for good, with every row that belongs to it
  // (REPLAY_SESSION_CHILD_TABLES), in one transaction under the session lock. An unended
  // session is refused (409: end it first); another user's is a 404.
  async remove(userId: string, sessionId: string): Promise<void> {
    assertUserId(userId);
    await this.lock.run(sessionId, () => this.dataSource.transaction(async (manager) => {
      const session = await manager.findOne(ReplaySessionEntity, {
        where: { id: sessionId, userId }, lock: { mode: 'pessimistic_write' },
      });
      if (!session) throw new NotFoundException('No such replay session');
      if (session.status !== 'ENDED') throw new ConflictException('End the session before deleting it');
      for (const table of REPLAY_SESSION_CHILD_TABLES) {
        await manager.query(`DELETE FROM ${table} WHERE session_id = $1`, [session.id]);
      }
      const [, deleted] = await manager.query(
        `DELETE FROM replay_sessions WHERE id = $1 AND user_id = $2 AND status = 'ENDED'`, [session.id, userId]) as [unknown, number];
      if (deleted !== 1) throw new Error(`replay session ${session.id} changed while deleting`);
    }));
  }

  private titleOrAuto(raw: unknown, pair: string, timeframe: string, start: Date): string {
    const result = normalizeTitle(raw);
    if (result.error !== null) throw new BadRequestException(result.error);
    return result.title ?? autoTitle(pair, timeframe, start);
  }

  // Ends the named session (the user's, not ENDED; it needn't be the current one): pending
  // orders are cancelled, open positions close at the clock minute's close (a long at the
  // bid, a short at the ask; reason SESSION_END), all in one transaction under the session lock.
  async end(userId: string, sessionId: string): Promise<EndedSession> {
    assertUserId(userId);
    return this.lock.run(sessionId, () => this.dataSource.transaction(async (manager) => {
      const session = await manager.findOne(ReplaySessionEntity, {
        where: { id: sessionId, userId, status: Not('ENDED') }, lock: { mode: 'pessimistic_write' },
      });
      if (!session) throw new NotFoundException(NO_SUCH_SESSION);
      const ctx = await this.pairs.get(session.pair);

      const now = new Date();
      const pending = await manager.find(ReplayPositionEntity, { where: { sessionId: session.id, status: 'PENDING' }, order: { createdAt: 'ASC', id: 'ASC' } });
      for (const p of pending) Object.assign(p, { status: 'CANCELLED', cancelledAt: now });
      await manager.save(pending);

      const open = await manager.find(ReplayPositionEntity, { where: { sessionId: session.id, status: 'OPEN' }, order: { createdAt: 'ASC', id: 'ASC' } });
      let total = 0n;
      if (open.length > 0) {
        const minute = await minuteAt(this.dataSource, session.pair, session.clockTime);
        for (const p of open) {
          const engine = toEngine(p);
          closeAtMinuteClose(engine, minute, ctx, 'SESSION_END');
          applyEngine(p, engine);
          total += engine.realizedCents as bigint;
        }
        await manager.save(open);
      }
      await this.addToBalanceAndEnd(manager, session.id, total, now);

      const ended = await manager.findOneByOrFail(ReplaySessionEntity, { id: session.id, userId });
      return {
        session: sessionView(ended, ctx.lastTime),
        closed: open.map((p) => positionView(p, ctx.priceDecimals)),
        cancelled: pending.map((p) => positionView(p, ctx.priceDecimals)),
      };
    }));
  }

  // Relative update: never write back a balance read earlier
  private async addToBalanceAndEnd(manager: EntityManager, sessionId: string, cents: bigint, now: Date): Promise<void> {
    await manager.query(
      `UPDATE replay_sessions SET balance = balance + $2::numeric, status = 'ENDED', pause_reason = NULL, ended_at = $3, updated_at = $3
        WHERE id = $1`, [sessionId, centsToDecimal(cents), now]);
  }
}
