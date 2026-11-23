import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Not, Repository } from 'typeorm';
import { assertUserId } from '@forexedge/common';
import { HistoricalTimeframe, ReplayPauseReason, ReplaySessionEntity } from '@forexedge/database';
import { centsToDecimal } from '../engine/booking';
import { applyEngine, toEngine } from '../engine/position-mapping';
import { EngineEvent, runMinute } from '../engine/replay-engine';
import { SessionLock } from '../engine/session-lock';
import { PairContextService } from '../history/pair-context.service';
import { currentBar, nextBarMinutes } from '../history/replay-bars';
import { PairContext } from '../history/replay-history';
import { calendarCurrencies, calendarEvents } from '../history/replay-calendar';
import { accountView } from '../session/account.view';
import { barView } from '../session/bar.view';
import { positionView } from '../session/position.view';
import { REPLAY_TIMEFRAMES } from '../session/replay-window';
import { sessionView, SessionView } from '../session/session.view';
import { ReplayEmitter } from './replay-emitter';
import { ReplayState, ReplayStateService } from './replay-state.service';

// Seconds per displayed bar: 0.5 s is the top speed
export const REPLAY_SPEEDS_MS = [500, 1000, 2000] as const;

// A command the session's state doesn't allow (the socket answers { ok: false, error })
export class ReplayCommandError extends Error {}

export interface StepResult {
  session: SessionView;
  minutes: number;     // M1 minutes processed
  endOfData: boolean;
}

// The replay clock. The server owns it: a bar is processed minute by minute through
// the engine, saved, and only then sent. One timer per PLAYING session; every command
// and every timer step on a session runs under its SessionLock.
//
//   play     PAUSED -> PLAYING; a bar every speedMs (refused at the end of the data)
//   pause    PLAYING -> PAUSED
//   step     one bar while PAUSED
//   speed    500, 1000 or 2000 ms per bar, nothing else
//   frame    the chart's timeframe (one of the aggregates'); sends the full state again
//
// Never playing without a client: the last socket leaving pauses the session, a
// (re)connecting socket always finds it PAUSED, and a boot pauses every PLAYING session.
// Every pause records why (pause_reason, cleared by play):
//   USER            pause
//   OTHER_TAB       a socket connected while another socket of the user was connected
//                   (replaces USER or DISCONNECT on a paused session; END_OF_DATA stays)
//   DISCONNECT      the last socket left while playing (a lone reconnect keeps it)
//   SERVER_RESTART  boot or clean stop
//   END_OF_DATA     the clock reached the pair's last minute
// A step that fails while playing pauses with no reason and says so with a status event.
@Injectable()
export class PlaybackService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PlaybackService.name);
  // sessionId -> the current timer and its token; a timer whose token is no longer the
  // session's current one does nothing (it fired while a pause/play was waiting)
  private readonly timers = new Map<string, { handle: NodeJS.Timeout; token: number }>();
  private readonly tokens = new Map<string, number>();

  constructor(
    @InjectRepository(ReplaySessionEntity) private readonly sessions: Repository<ReplaySessionEntity>,
    private readonly dataSource: DataSource,
    private readonly pairs: PairContextService,
    private readonly lock: SessionLock,
    private readonly emitter: ReplayEmitter,
    private readonly state: ReplayStateService,
  ) {}

  // A boot never resumes playback: nobody is connected yet
  async onModuleInit(): Promise<void> {
    const paused = await this.pauseAllPlaying();
    if (paused > 0) this.logger.log(`Paused ${paused} replay session(s) left PLAYING by the previous run`);
  }

  async onModuleDestroy(): Promise<void> {
    for (const id of [...this.timers.keys()]) this.cancelTimer(id);
    await this.pauseAllPlaying().catch((err) => this.logger.warn(`Could not pause sessions on shutdown: ${err}`));
  }

  async pauseAllPlaying(): Promise<number> {
    const rows: unknown[] = await this.dataSource.query(
      `UPDATE replay_sessions SET status = 'PAUSED', pause_reason = 'SERVER_RESTART', updated_at = now()
        WHERE status = 'PLAYING' RETURNING id`);
    return Array.isArray(rows[0]) ? (rows[0] as unknown[]).length : rows.length;
  }

  // ── Commands ──

  play(userId: string): Promise<SessionView> {
    return this.withSession(userId, async (s, ctx) => {
      if (s.clockTime.getTime() >= ctx.lastTime.getTime()) {
        throw new ReplayCommandError(`End of data: the ${s.pair} history ends at ${ctx.lastTime.toISOString()}`);
      }
      if (s.status !== 'PLAYING') await this.setStatus(s, 'PLAYING', null);
      this.schedule(s.id, userId, s.speedMs);
      return this.announce(s, ctx);
    });
  }

  pause(userId: string): Promise<SessionView> {
    return this.withSession(userId, async (s, ctx) => {
      this.cancelTimer(s.id);
      if (s.status === 'PLAYING') await this.setStatus(s, 'PAUSED', 'USER');
      return this.announce(s, ctx);
    });
  }

  step(userId: string): Promise<StepResult> {
    return this.withSession(userId, async (s, ctx) => {
      if (s.status === 'PLAYING') throw new ReplayCommandError('Pause before stepping');
      return this.advance(s, ctx);
    });
  }

  setSpeed(userId: string, speedMs: unknown): Promise<SessionView> {
    if (typeof speedMs !== 'number' || !(REPLAY_SPEEDS_MS as readonly number[]).includes(speedMs)) {
      return Promise.reject(new ReplayCommandError('speedMs must be 500, 1000 or 2000 (milliseconds per bar)'));
    }
    return this.withSession(userId, async (s, ctx) => {
      await this.sessions.update({ id: s.id }, { speedMs });
      s.speedMs = speedMs;
      return this.announce(s, ctx);
    });
  }

  setTimeframe(userId: string, timeframe: unknown): Promise<ReplayState> {
    if (typeof timeframe !== 'string' || !(REPLAY_TIMEFRAMES as readonly string[]).includes(timeframe)) {
      return Promise.reject(new ReplayCommandError(`timeframe must be one of ${REPLAY_TIMEFRAMES.join(', ')}`));
    }
    return this.withSession(userId, async (s) => {
      await this.sessions.update({ id: s.id }, { timeframe });
      s.timeframe = timeframe;
      const state = await this.state.state(await this.reload(s));
      this.emitter.toUser(userId, 'state', state, s.clockTime);
      return state;
    });
  }

  // A socket connected: the session is paused (never auto-play) and its full state
  // returned. With another socket of the user already connected (otherSockets), the
  // reason becomes OTHER_TAB and every socket is told; alone, a playing session pauses
  // as DISCONNECT (its previous socket is gone) and a paused one keeps its reason.
  async connected(userId: string, otherSockets: boolean): Promise<ReplayState | null> {
    assertUserId(userId);
    const found = await this.sessions.findOne({ where: { userId, status: Not('ENDED') } });
    if (!found) return null;
    return this.lock.run(found.id, async () => {
      const s = await this.sessions.findOne({ where: { id: found.id, userId, status: Not('ENDED') } });
      if (!s) return null;
      this.cancelTimer(s.id);
      const reason: ReplayPauseReason | null = otherSockets
        ? (s.pauseReason === 'END_OF_DATA' ? 'END_OF_DATA' : 'OTHER_TAB')
        : (s.status === 'PLAYING' ? 'DISCONNECT' : s.pauseReason);
      if (s.status === 'PLAYING' || reason !== s.pauseReason) {
        await this.setStatus(s, 'PAUSED', reason);
        this.emitter.toUser(userId, 'status', sessionView(s, (await this.pairs.get(s.pair)).lastTime), s.clockTime);
      }
      return this.state.state(s);
    });
  }

  // The user's last socket left: pause and save now
  async lastSocketLeft(userId: string): Promise<void> {
    assertUserId(userId);
    const found = await this.sessions.findOne({ where: { userId, status: Not('ENDED') } });
    if (!found) return;
    await this.lock.run(found.id, async () => {
      this.cancelTimer(found.id);
      await this.sessions.update({ id: found.id, userId, status: 'PLAYING' }, { status: 'PAUSED', pauseReason: 'DISCONNECT' });
    });
  }

  // The session ended (REST): no timer may touch it again
  forget(sessionId: string): void {
    this.cancelTimer(sessionId);
    this.tokens.delete(sessionId);
  }

  // ── Stepping ──

  // Processes the next bar's minutes in order through the engine, saves positions,
  // balance and clock in one transaction, then sends the bar, the account, the
  // positions that changed and the calendar events the step passed. At the end of the
  // data a PLAYING session pauses.
  private async advance(s: ReplaySessionEntity, ctx: PairContext): Promise<StepResult> {
    const timeframe = s.timeframe as HistoricalTimeframe;
    const minutes = await nextBarMinutes(this.dataSource, s.pair, timeframe, s.clockTime);
    if (minutes.length === 0) {
      await this.endOfData(s, ctx);
      return { session: sessionView(s, ctx.lastTime), minutes: 0, endOfData: true };
    }

    const entities = await this.state.livePositions(s.id);
    const engine = entities.map(toEngine);
    const events: EngineEvent[] = [];
    for (const minute of minutes) events.push(...runMinute(engine, minute, ctx));
    const realized = events.reduce((sum, e) => (e.type === 'CLOSED' ? sum + e.realizedCents : sum), 0n);
    const changedIds = new Set(events.map((e) => e.positionId));
    const changed = entities.filter((e) => changedIds.has(e.id))
      .map((e) => applyEngine(e, engine.find((p) => p.id === e.id) as (typeof engine)[number]));
    const clock = minutes[minutes.length - 1].time;
    const previousClock = s.clockTime;

    await this.dataSource.transaction(async (manager) => {
      if (changed.length > 0) await manager.save(changed);
      const result: [unknown[], number] = await manager.query(
        `UPDATE replay_sessions SET balance = balance + $2::numeric, clock_time = $3, updated_at = now()
          WHERE id = $1 AND status <> 'ENDED' AND clock_time = $4`, [s.id, centsToDecimal(realized), clock, s.clockTime]);
      if (result[1] !== 1) throw new Error(`replay session ${s.id} changed while stepping`);
    });

    const saved = await this.reload(s);
    const live = entities.filter((e) => e.status === 'PENDING' || e.status === 'OPEN');
    const bar = await currentBar(this.dataSource, saved.pair, timeframe, saved.clockTime);
    const last = minutes[minutes.length - 1];
    this.emitter.toUser(saved.userId, 'bar', {
      sessionId: saved.id, timeframe, clockTime: saved.clockTime.toISOString(), bar: barView(bar, ctx.priceDecimals),
    }, saved.clockTime);
    if (changed.length > 0) {
      this.emitter.toUser(saved.userId, 'positions', changed.map((p) => positionView(p, ctx.priceDecimals)), saved.clockTime);
    }
    this.emitter.toUser(saved.userId, 'account', accountView(saved.balance, live, last, ctx), saved.clockTime);
    // Calendar events the step passed: after the previous clock, up to the new one
    const passed = await calendarEvents(this.dataSource, calendarCurrencies(saved.pair), timeframe,
      { after: previousClock, from: null, upTo: saved.clockTime });
    if (passed.length > 0) {
      this.emitter.toUser(saved.userId, 'calendar', {
        sessionId: saved.id, timeframe, clockTime: saved.clockTime.toISOString(), events: passed,
      }, saved.clockTime);
    }

    const atEnd = saved.clockTime.getTime() >= ctx.lastTime.getTime();
    if (atEnd) await this.endOfData(saved, ctx);
    return { session: sessionView(saved, ctx.lastTime), minutes: minutes.length, endOfData: atEnd };
  }

  private async endOfData(s: ReplaySessionEntity, ctx: PairContext): Promise<void> {
    this.cancelTimer(s.id);
    if (s.status !== 'PAUSED' || s.pauseReason !== 'END_OF_DATA') {
      await this.setStatus(s, 'PAUSED', 'END_OF_DATA');
      this.announce(s, ctx);
    }
    this.emitter.toUser(s.userId, 'endOfData', {
      sessionId: s.id, clockTime: s.clockTime.toISOString(),
      message: `End of data: the ${s.pair} history ends at ${ctx.lastTime.toISOString()}`,
    }, s.clockTime);
  }

  // ── Timers ──

  private schedule(sessionId: string, userId: string, delayMs: number): void {
    this.cancelTimer(sessionId);
    const token = (this.tokens.get(sessionId) ?? 0) + 1;
    this.tokens.set(sessionId, token);
    const handle = setTimeout(() => void this.tick(sessionId, userId, token), delayMs);
    this.timers.set(sessionId, { handle, token });
  }

  private cancelTimer(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer) clearTimeout(timer.handle);
    this.timers.delete(sessionId);
    this.tokens.set(sessionId, (this.tokens.get(sessionId) ?? 0) + 1);
  }

  private async tick(sessionId: string, userId: string, token: number): Promise<void> {
    const started = Date.now();
    try {
      const next = await this.lock.run(sessionId, async () => {
        if (this.tokens.get(sessionId) !== token) return null;
        const s = await this.sessions.findOne({ where: { id: sessionId, userId } });
        if (!s || s.status !== 'PLAYING') return null;
        const result = await this.advance(s, await this.pairs.get(s.pair));
        const after = await this.sessions.findOneBy({ id: sessionId });
        return after?.status === 'PLAYING' && !result.endOfData ? after.speedMs : null;
      });
      if (next !== null && this.tokens.get(sessionId) === token) {
        this.schedule(sessionId, userId, Math.max(0, next - (Date.now() - started)));
      } else if (this.timers.get(sessionId)?.token === token) {
        this.timers.delete(sessionId);
      }
    } catch (err) {
      this.logger.error(`Replay step failed for session ${sessionId}: ${err instanceof Error ? err.message : err}`);
      this.cancelTimer(sessionId);
      await this.pauseAfterFailure(sessionId, userId).catch((e) =>
        this.logger.error(`Could not pause session ${sessionId} after a failed step: ${e instanceof Error ? e.message : e}`));
    }
  }

  // No reason fits a failed step: the session is PAUSED with none, and the user's
  // sockets are told (they would otherwise still show it playing)
  private async pauseAfterFailure(sessionId: string, userId: string): Promise<void> {
    await this.sessions.update({ id: sessionId, userId, status: 'PLAYING' }, { status: 'PAUSED', pauseReason: null });
    const s = await this.sessions.findOneBy({ id: sessionId, userId });
    if (s && s.status === 'PAUSED') {
      this.emitter.toUser(userId, 'status', sessionView(s, (await this.pairs.get(s.pair)).lastTime), s.clockTime);
    }
  }

  // ── Helpers ──

  private async withSession<T>(userId: string, work: (s: ReplaySessionEntity, ctx: PairContext) => Promise<T>): Promise<T> {
    assertUserId(userId);
    const found = await this.sessions.findOne({ where: { userId, status: Not('ENDED') } });
    if (!found) throw new ReplayCommandError('No active replay session');
    return this.lock.run(found.id, async () => {
      const s = await this.sessions.findOne({ where: { id: found.id, userId, status: Not('ENDED') } });
      if (!s) throw new ReplayCommandError('No active replay session');
      return work(s, await this.pairs.get(s.pair));
    });
  }

  private async setStatus(s: ReplaySessionEntity, status: 'PLAYING' | 'PAUSED', pauseReason: ReplayPauseReason | null): Promise<void> {
    await this.sessions.update({ id: s.id }, { status, pauseReason });
    s.status = status;
    s.pauseReason = pauseReason;
  }

  private announce(s: ReplaySessionEntity, ctx: PairContext): SessionView {
    const view = sessionView(s, ctx.lastTime);
    this.emitter.toUser(s.userId, 'status', view, s.clockTime);
    return view;
  }

  private async reload(s: ReplaySessionEntity): Promise<ReplaySessionEntity> {
    return this.sessions.findOneByOrFail({ id: s.id, userId: s.userId });
  }
}
