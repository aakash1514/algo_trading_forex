import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
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
import { sessionView, SessionView } from './session.view';

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
      title: autoTitle(pair, dto.timeframe, start), lastOpenedAt: new Date(),
    }));
    return sessionView(await this.sessions.findOneByOrFail({ id: saved.id, userId }), ctx.lastTime);
  }

  // The user's current session (read only)
  async getActive(userId: string): Promise<SessionView> {
    const session = await currentSession(this.sessions, userId);
    if (!session) throw new NotFoundException('No active replay session');
    return sessionView(session, (await this.pairs.get(session.pair)).lastTime);
  }

  // Ends the named session (the user's, not ENDED; it needn't be the current one): pending orders are cancelled, open positions close at the
  // clock minute's close (a long at the bid, a short at the ask; reason SESSION_END),
  // all in one transaction under the session lock.
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
