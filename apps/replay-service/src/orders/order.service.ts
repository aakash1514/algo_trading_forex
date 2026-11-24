import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { checkMargin, entryQuotes, exitQuotes, marginRequiredCents, positionUnits, Side } from '@forexedge/trading-sim';
import { assertUserId } from '@forexedge/common';
import { ReplayPositionEntity, ReplaySessionEntity } from '@forexedge/database';
import { centsToDecimal } from '../engine/booking';
import { SessionLock } from '../engine/session-lock';
import { PairContextService } from '../history/pair-context.service';
import { Minute, minuteAt, PairContext } from '../history/replay-history';
import { ReplayEmitter } from '../playback/replay-emitter';
import { ReplayStateService } from '../playback/replay-state.service';
import { accountCents, AccountView } from '../session/account.view';
import { liveSession, NO_SUCH_SESSION, OTHER_SESSION_OPENED } from '../session/current-session';
import { positionView, PositionView } from '../session/position.view';
import { PlaceOrderDto } from './dto/place-order.dto';

export interface OrderResult {
  position: PositionView;
  account: AccountView;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Replay orders on the session the request names, allowed while it is PLAYING or PAUSED
// and the user's current session. An order is decided
// at the clock minute's close, so it is saved PENDING and fills at the next processed
// minute's open (the backtester's next-open rule); a manual close is pending the same
// way. Validation uses the clock minute's close, the last price the user has seen:
//   SL/TP     whole points on the right side (LONG: SL < bid < TP; SHORT: TP < ask < SL)
//   margin    marginRequiredUsd at the side's close (BUY at the ask, SELL at the bid),
//             leverage 1:100 capped by max_leverage, against free margin = equity -
//             margin of the open positions and pending orders
// Every change runs under the session lock and is sent to the user's sockets.
@Injectable()
export class ReplayOrderService {
  constructor(
    @InjectRepository(ReplaySessionEntity) private readonly sessions: Repository<ReplaySessionEntity>,
    @InjectRepository(ReplayPositionEntity) private readonly positions: Repository<ReplayPositionEntity>,
    private readonly dataSource: DataSource,
    private readonly pairs: PairContextService,
    private readonly lock: SessionLock,
    private readonly state: ReplayStateService,
    private readonly emitter: ReplayEmitter,
  ) {}

  place(userId: string, sessionId: string, dto: PlaceOrderDto): Promise<OrderResult> {
    return this.withSession(userId, sessionId, async (s, ctx, clock) => {
      this.refuseAtEndOfData(s, ctx, 'no later minute to fill the order at');
      const side: Side = dto.side;
      let units: number;
      try {
        units = positionUnits(dto.lots, ctx.lotSize);
      } catch (err) {
        throw new BadRequestException((err as Error).message);
      }
      const stopLossPoints = this.levelPoints('stopLoss', dto.stopLoss, ctx);
      const takeProfitPoints = this.levelPoints('takeProfit', dto.takeProfit, ctx);
      this.checkLevels(side, stopLossPoints, takeProfitPoints, clock, ctx);

      const live = await this.state.livePositions(s.id);
      const account = accountCents(s.balance, live, clock, ctx);
      const required = marginRequiredCents({
        pair: ctx.pair, lots: dto.lots, spec: { lotSize: ctx.lotSize, pipSize: ctx.pipSize, maxLeverage: ctx.maxLeverage },
        pricePoints: entryQuotes(side, clock).close, priceDecimals: ctx.priceDecimals,
      });
      const margin = checkMargin(required, account.equity, account.marginUsed);
      if (!margin.ok) {
        throw new BadRequestException(
          `Insufficient margin: need $${centsToDecimal(margin.requiredCents)}, free margin $${centsToDecimal(margin.freeCents)}`);
      }

      const position = await this.positions.save(this.positions.create({
        sessionId: s.id, side, lots: dto.lots.toFixed(2), units, status: 'PENDING', placedAt: s.clockTime,
        stopLossPoints, takeProfitPoints, marginUsd: centsToDecimal(required),
        entryTime: null, entryPoints: null, exitRequestedAt: null, exitTime: null, exitPoints: null,
        exitReason: null, realizedPnlUsd: null, cancelledAt: null,
      }));
      return this.publish(s, ctx, position);
    });
  }

  close(userId: string, sessionId: string, positionId: string): Promise<OrderResult> {
    return this.withSession(userId, sessionId, async (s, ctx) => {
      const position = await this.findPosition(s, positionId);
      if (position.status === 'PENDING') throw new ConflictException('The order has not filled yet: cancel it instead');
      if (position.status !== 'OPEN') throw new ConflictException(`The position is already ${position.status}`);
      if (position.exitRequestedAt) throw new ConflictException('A close is already pending for this position');
      this.refuseAtEndOfData(s, ctx, 'end the session to close at the last price');
      position.exitRequestedAt = s.clockTime;
      return this.publish(s, ctx, await this.positions.save(position));
    });
  }

  // A PENDING order only; its reserved margin is released (only open and pending count)
  cancel(userId: string, sessionId: string, orderId: string): Promise<OrderResult> {
    return this.withSession(userId, sessionId, async (s, ctx) => {
      const order = await this.findPosition(s, orderId);
      if (order.status !== 'PENDING') {
        throw new ConflictException(order.status === 'CANCELLED' ? 'The order is already cancelled' : 'The order has already filled');
      }
      Object.assign(order, { status: 'CANCELLED', cancelledAt: new Date() });
      return this.publish(s, ctx, await this.positions.save(order));
    });
  }

  // ── Helpers ──

  // The named session under its lock: the user's (another user's is a 404), not ENDED (404),
  // and the user's current one (409: a stale tab's order never reaches another session)
  private async withSession<T>(
    userId: string, sessionId: string, work: (s: ReplaySessionEntity, ctx: PairContext, clock: Minute) => Promise<T>,
  ): Promise<T> {
    assertUserId(userId);
    return this.lock.run(sessionId, async () => {
      const { session: s, refused } = await liveSession(this.sessions, userId, sessionId, true);
      if (refused || !s) {
        throw refused === 'not-current' ? new ConflictException(OTHER_SESSION_OPENED) : new NotFoundException(NO_SUCH_SESSION);
      }
      const ctx = await this.pairs.get(s.pair);
      return work(s, ctx, await minuteAt(this.dataSource, s.pair, s.clockTime));
    });
  }

  // Scoped by the session (itself scoped by the owner): another user's id is a 404
  private async findPosition(s: ReplaySessionEntity, id: string): Promise<ReplayPositionEntity> {
    const position = UUID.test(id) ? await this.positions.findOne({ where: { id, sessionId: s.id } }) : null;
    if (!position) throw new NotFoundException('No such order or position in your replay session');
    return position;
  }

  private refuseAtEndOfData(s: ReplaySessionEntity, ctx: PairContext, what: string): void {
    if (s.clockTime.getTime() >= ctx.lastTime.getTime()) {
      throw new ConflictException(`End of data: the ${ctx.pair} history ends at ${ctx.lastTime.toISOString()}; ${what}`);
    }
  }

  // A price level -> points, which must be whole at the pair's scale
  private levelPoints(name: string, price: number | undefined, ctx: PairContext): number | null {
    if (price === undefined) return null;
    const scaled = price * 10 ** ctx.priceDecimals;
    const points = Math.round(scaled);
    if (Math.abs(scaled - points) > 1e-6) {
      throw new BadRequestException(`${name} must have at most ${ctx.priceDecimals} decimals for ${ctx.pair}`);
    }
    return points;
  }

  // LONG: SL < bid < TP; SHORT: TP < ask < SL, at the clock minute's close (the price a
  // position exits on)
  private checkLevels(side: Side, sl: number | null, tp: number | null, clock: Minute, ctx: PairContext): void {
    const ref = exitQuotes(side, clock).close;
    const price = (points: number) => (points / 10 ** ctx.priceDecimals).toFixed(ctx.priceDecimals);
    const [quote, slSide, tpSide] = side === 'BUY' ? ['bid', 'below', 'above'] : ['ask', 'above', 'below'];
    const slOk = sl === null || (side === 'BUY' ? sl < ref : sl > ref);
    const tpOk = tp === null || (side === 'BUY' ? tp > ref : tp < ref);
    if (!slOk) throw new BadRequestException(`stopLoss ${price(sl as number)} must be ${slSide} the ${quote} ${price(ref)}`);
    if (!tpOk) throw new BadRequestException(`takeProfit ${price(tp as number)} must be ${tpSide} the ${quote} ${price(ref)}`);
  }

  private async publish(s: ReplaySessionEntity, ctx: PairContext, position: ReplayPositionEntity): Promise<OrderResult> {
    const view = positionView(position, ctx.priceDecimals);
    const account = await this.state.account(s);
    this.emitter.toUser(s.userId, 'positions', [view], s.clockTime);
    this.emitter.toUser(s.userId, 'account', account, s.clockTime);
    return { position: view, account };
  }
}
