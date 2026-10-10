import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, IsNull, Not } from 'typeorm';
import { PositionEntity, AccountSummaryEntity, OrderEntity, type CloseReason, type ExitTrigger } from '@forexedge/database';
import { RealtimePublisher } from '../realtime/realtime-publisher.service';
import { assertUserId, pipValueUsd, pipsBetween } from '@forexedge/common';
import { PricingService } from '../pricing/pricing.service';
import { OpenPairsIndex } from './open-pairs.index';
import { MarketHoursPolicy, marketClosedReason } from '../market/market-hours.policy';
import { exitLevelProblem, type ExitLevels } from '../order/exit-levels';
import type { TickMessage } from '@forexedge/kafka';

// The forex.ticks fields position processing uses (TickMessage is the contract)
export type NormalizedTick = Pick<TickMessage, 'pair' | 'bid' | 'ask' | 'mid' | 'timestamp'>;

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

// Closing a position that is no longer open: 409 over HTTP; the tick path,
// which can race with a manual close, catches it and moves on.
export class PositionAlreadyClosedError extends ConflictException {
  constructor(positionId: string) {
    super(`Position ${positionId} is already closed`);
  }
}

@Injectable()
export class PositionService {
  private readonly logger = new Logger(PositionService.name);

  constructor(
    @InjectRepository(PositionEntity)
    private readonly positionRepo: Repository<PositionEntity>,
    @InjectRepository(OrderEntity)
    private readonly orderRepo: Repository<OrderEntity>,
    private readonly dataSource: DataSource,
    private readonly realtime: RealtimePublisher,
    private readonly pricing: PricingService,
    private readonly openPairs: OpenPairsIndex,
    private readonly marketHours: MarketHoursPolicy,
  ) {}

  // P&L of a position at `price`, converted to USD at the current quote->USD
  // rate (exact for USD-base and cross pairs, not just USD-quote ones).
  // `streamMids`: prices from the same tick batch, preferred for cross rates.
  async valueAt(
    position: PositionEntity, price: number, streamMids?: ReadonlyMap<string, number>,
  ): Promise<{ pipPnl: number; pipValue: number; pnl: number }> {
    const spec = await this.pricing.getSpec(position.pair);
    const quoteToUsd = await this.pricing.quoteToUsd(position.pair, price, streamMids);
    const pipPnl = pipsBetween(position.direction, Number(position.openPrice), price, spec);
    const pipValue = pipValueUsd(Number(position.lots), spec, quoteToUsd);
    return { pipPnl, pipValue, pnl: this.calculateUnrealizedPnl(pipPnl, pipValue) };
  }

  // ─── Called by the Kafka tick consumer, once per consumed batch ───────────
  // Ticks arrive in feed order. Pairs without open positions are skipped
  // without touching the DB (OpenPairsIndex), and so are ticks stamped while
  // the instrument's market is closed (a real feed sends none; the mock feed
  // can be told to). For the rest, stop-loss and take-profit are checked
  // against EVERY tick, so a level touched by one tick and left by the next
  // still triggers, while the P&L mark is written once per pair from the latest
  // tick: intermediate marks would be overwritten anyway. Returns the users
  // whose positions were touched (for the margin-call check).
  //
  // The batch's offsets are committed when this returns, so its ticks are never
  // re-delivered. A triggered exit is therefore committed on the position
  // (pending_exit_*) before it is booked; if booking fails (e.g. no USD
  // conversion rate for a cross pair) it is retried from the DB on every batch,
  // also after a restart. Only P&L marks are ever skipped.
  async processTicks(ticks: NormalizedTick[]): Promise<Set<string>> {
    const affectedUsers = new Set<string>();

    // Latest price of every pair in the batch, including pairs without positions:
    // the conversion rates for cross pairs at this point in the feed.
    const streamMids = new Map<string, number>();
    for (const tick of ticks) streamMids.set(tick.pair, tick.mid);

    await this.retryPendingExits(streamMids);

    const byPair = new Map<string, NormalizedTick[]>();
    for (const tick of ticks) {
      if (!this.openPairs.has(tick.pair)) continue;
      const list = byPair.get(tick.pair) ?? [];
      list.push(tick);
      byPair.set(tick.pair, list);
    }

    // Each pair is processed independently, so one pair failing never skips the
    // stop-loss checks and P&L marks of the other pairs in the batch.
    for (const [pair, pairTicks] of byPair) {
      try {
        const tradable = await this.ticksWhileOpen(pair, pairTicks);
        if (tradable.length) await this.processPairTicks(pair, tradable, affectedUsers, streamMids);
      } catch (err) {
        this.logger.error(
          `Dropped ${pairTicks.length} ${pair} tick(s); their offsets are committed with the batch: ${errorMessage(err)}`,
        );
      }
    }
    return affectedUsers;
  }

  // Ticks stamped while the pair's market is open (judged at the tick's own
  // time, so a backlog replayed after a restart is judged correctly).
  private async ticksWhileOpen(pair: string, ticks: NormalizedTick[]): Promise<NormalizedTick[]> {
    if (!this.marketHours.enforced) return ticks;
    const kind = await this.pricing.getInstrumentKind(pair);
    return ticks.filter((t) => this.marketHours.status(kind, new Date(t.timestamp)).open);
  }

  private async processPairTicks(
    pair: string, pairTicks: NormalizedTick[], affectedUsers: Set<string>, streamMids: ReadonlyMap<string, number>,
  ): Promise<void> {
    // Positions with a held exit are booked by retryPendingExits only
    let positions = (await this.positionRepo.find({ where: { pair, isOpen: true } }))
      .filter((p) => p.pendingExitPrice === null);
    for (const position of positions) affectedUsers.add(position.userId);

    for (const tick of pairTicks) {
      const stillOpen: PositionEntity[] = [];
      for (const position of positions) {
        const trigger = this.exitTrigger(position, tick.mid);
        if (!trigger) {
          stillOpen.push(position);
          continue;
        }
        // Exits at this tick's price, even if it gapped past the level
        await this.triggerExit(position.id, trigger, tick.mid, new Date(tick.timestamp), streamMids);
      }
      positions = stillOpen;
    }

    // A failed mark (e.g. no conversion rate) skips only that position's P&L
    const latest = pairTicks[pairTicks.length - 1];
    let skipped = 0;
    let lastError: unknown;
    for (const position of positions) {
      try {
        await this.markToMarket(position, latest.mid, streamMids);
      } catch (err) {
        skipped++;
        lastError = err;
      }
    }
    if (skipped) {
      this.logger.warn(`Skipped the P&L mark of ${skipped} ${pair} position(s): ${errorMessage(lastError)}`);
    }
  }

  // Commits the triggered exit on the position first (first trigger wins), then
  // books it. If booking fails, the committed trigger is retried later.
  private async triggerExit(
    positionId: string, reason: ExitTrigger, price: number, at: Date, streamMids: ReadonlyMap<string, number>,
  ): Promise<void> {
    const held = await this.positionRepo
      .createQueryBuilder()
      .update(PositionEntity)
      .set({ pendingExitPrice: price, pendingExitReason: reason, exitTriggeredAt: at })
      .where('id = :positionId AND is_open AND pending_exit_price IS NULL', { positionId })
      .execute();
    if (!held.affected) return; // closed meanwhile, or already triggered
    await this.bookExit(positionId, reason, price, streamMids);
  }

  private async bookExit(
    positionId: string, reason: ExitTrigger, price: number, streamMids: ReadonlyMap<string, number>,
  ): Promise<void> {
    try {
      await this.closePosition(positionId, reason, price, streamMids);
    } catch (err) {
      if (err instanceof PositionAlreadyClosedError) return;
      this.logger.warn(`${reason} for position ${positionId} at ${price} held, booking retried: ${errorMessage(err)}`);
    }
  }

  // Held exits are read from the DB, so a restart can't lose one.
  private async retryPendingExits(streamMids: ReadonlyMap<string, number>): Promise<void> {
    const held = await this.positionRepo.find({ where: { isOpen: true, pendingExitPrice: Not(IsNull()) } });
    for (const position of held) {
      await this.bookExit(position.id, position.pendingExitReason as ExitTrigger, Number(position.pendingExitPrice), streamMids);
    }
  }

  // STOP_LOSS / TAKE_PROFIT when `price` reaches the position's level, else null.
  private exitTrigger(position: PositionEntity, price: number): ExitTrigger | null {
    const long = position.direction === 'LONG';
    if (position.stopLoss !== null) {
      const sl = Number(position.stopLoss);
      if (long ? price <= sl : price >= sl) return 'STOP_LOSS';
    }
    if (position.takeProfit !== null) {
      const tp = Number(position.takeProfit);
      if (long ? price >= tp : price <= tp) return 'TAKE_PROFIT';
    }
    return null;
  }

  // Writes the position's P&L at `currentPrice`. The account's open P&L is not
  // stored; it is summed from the positions on read, so nothing else to update.
  private async markToMarket(
    position: PositionEntity, currentPrice: number, streamMids?: ReadonlyMap<string, number>,
  ): Promise<void> {
    const { pipPnl, pipValue, pnl: unrealizedPnl } = await this.valueAt(position, currentPrice, streamMids);

    // The position was loaded before the awaits above, so it may have been
    // closed meanwhile. Re-read it under a row lock (closePosition takes the
    // same lock) and skip it if it's no longer open; otherwise this write would
    // overwrite the exit price and P&L of a closed position.
    const updated = await this.dataSource.transaction(async manager => {
      const locked = await manager.findOne(PositionEntity, {
        where: { id: position.id, isOpen: true },
        lock: { mode: 'pessimistic_write' },
      });
      if (!locked || locked.pendingExitPrice !== null) return false;
      await manager.update(PositionEntity, locked.id, { currentPrice, pipPnl, pipValue, unrealizedPnl });
      return true;
    });
    if (!updated) return;

    this.realtime.positionPnl(position, currentPrice, pipPnl, unrealizedPnl);
  }

  // ─── Apply daily swap to all open positions for an instrument ──────────────
  async applyDailySwap(instrument: string, swapPoints: number): Promise<void> {
    const positions = await this.positionRepo.find({
      where: { instrument, isOpen: true },
    });

    for (const position of positions) {
      // swap in account currency = swapPoints × pipValue
      const swapAmount = swapPoints * Number(position.pipValue);

      await this.dataSource.transaction(async manager => {
        await manager
          .createQueryBuilder()
          .update(PositionEntity)
          .set({ swapAccrued: () => 'swap_accrued + :swapAmount' })
          .where('id = :id', { id: position.id })
          .setParameters({ swapAmount })
          .execute();

        // Adjust account balance by swap amount (negative swap = cost to trader)
        await manager
          .createQueryBuilder()
          .update(AccountSummaryEntity)
          .set({ balance: () => 'balance + :swapAmount' })
          .where('user_id = :userId', { userId: position.userId })
          .setParameters({ swapAmount })
          .execute();
      });

      this.logger.debug(
        `Swap applied to position ${position.id}: ${swapAmount.toFixed(4)} USD`,
      );
    }
  }

  // ─── Close a position ──────────────────────────────────────────────────────
  async closePosition(
    positionId: string,
    reason: CloseReason,
    closingPrice: number,
    streamMids?: ReadonlyMap<string, number>,
  ): Promise<PositionEntity> {
    const closed = await this.dataSource.transaction(async manager => {
      // Row lock: serializes with the tick-driven P&L update and other closes
      const position = await manager.findOne(PositionEntity, {
        where: { id: positionId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!position) throw new Error(`Position ${positionId} not found`);
      if (!position.isOpen) throw new PositionAlreadyClosedError(positionId);

      const { pipPnl, pnl: realizedPnl } = await this.valueAt(position, closingPrice, streamMids);

      // Close the position. exit_triggered_at stays as the record of a
      // stop-loss/take-profit trigger; the held exit itself is done.
      await manager.update(PositionEntity, positionId, {
        isOpen: false,
        closedAt: new Date(),
        closeReason: reason,
        currentPrice: closingPrice,
        pipPnl,
        realizedPnl,
        unrealizedPnl: 0,
        pendingExitPrice: null,
        pendingExitReason: null,
      });

      // Update order status to CLOSED. executed_price stays the entry fill;
      // the exit price lives on the position (current_price at close).
      await manager.update(OrderEntity, position.orderId, {
        status: 'CLOSED',
        closedAt: new Date(),
      });

      // Account: realize the P&L and release the margin. Relative updates only:
      // writing back a row read earlier would discard concurrent changes.
      await manager
        .createQueryBuilder()
        .update(AccountSummaryEntity)
        .set({
          balance: () => 'balance + :realizedPnl',
          marginUsed: () => 'GREATEST(0, margin_used - :releasedMargin)',
        })
        .where('user_id = :userId', { userId: position.userId })
        .setParameters({ realizedPnl, releasedMargin: Number(position.marginUsed) })
        .execute();

      this.logger.log(
        `Position ${positionId} closed — reason: ${reason}, P&L: $${realizedPnl.toFixed(2)}`,
      );

      return manager.findOne(PositionEntity, { where: { id: positionId } }) as Promise<PositionEntity>;
    });

    // Only after the transaction committed: the open-pairs index and the publish.
    this.openPairs.closed(closed.pair);
    void this.realtime.positionsChanged(closed.userId, closed.id);
    return closed;
  }

  // ─── Pure math ─────────────────────────────────────────────────────────────

  // Returns unrealized P&L in account currency (USD)
  calculateUnrealizedPnl(pipPnl: number, pipValue: number): number {
    return Math.round(pipPnl * pipValue * 100) / 100;
  }

  // ─── Queries ───────────────────────────────────────────────────────────────
  async getOpenPositions(userId: string): Promise<PositionEntity[]> {
    assertUserId(userId);
    return this.positionRepo.find({
      where: { userId, isOpen: true },
      order: { openedAt: 'DESC' },
    });
  }

  async getPosition(userId: string, positionId: string): Promise<PositionEntity> {
    assertUserId(userId);
    const position = await this.positionRepo.findOne({
      where: { id: positionId, userId },
    });
    if (!position) throw new NotFoundException(`Position ${positionId} not found`);
    return position;
  }

  // Manual close at the live market: a LONG sells at the bid, a SHORT buys at the
  // ask. Rejected while the instrument's market is closed (there is no price to
  // trade at).
  async closeAtMarket(userId: string, positionId: string): Promise<PositionEntity> {
    const position = await this.getPosition(userId, positionId);
    const status = this.marketHours.status(await this.pricing.getInstrumentKind(position.pair));
    if (!status.open) throw new ConflictException(marketClosedReason(position.pair, status));
    const quote = await this.pricing.getQuote(position.pair);
    const closingPrice = position.direction === 'LONG' ? quote.bid : quote.ask;
    return this.closePosition(positionId, 'MANUAL', closingPrice);
  }

  // ─── Change SL/TP: PATCH /positions/:id ───────────────────────────────────
  // Each level is set (number), cleared (null) or left as is (absent). Allowed
  // while the market is closed: the levels are validated against the last known
  // price with the same rule as order placement.
  async updateExitLevels(
    userId: string, positionId: string, changes: Partial<ExitLevels>,
  ): Promise<PositionEntity> {
    assertUserId(userId);
    if (!('stopLoss' in changes) && !('takeProfit' in changes)) {
      throw new BadRequestException('Provide stopLoss and/or takeProfit (a number to set, null to clear)');
    }

    const updated = await this.dataSource.transaction(async manager => {
      const position = await manager.findOne(PositionEntity, {
        where: { id: positionId, userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!position) throw new NotFoundException(`Position ${positionId} not found`);
      if (!position.isOpen) throw new PositionAlreadyClosedError(positionId);
      if (position.pendingExitPrice !== null) {
        throw new ConflictException(`Position ${positionId} already has a triggered ${position.pendingExitReason} exit`);
      }

      const levels: ExitLevels = {
        stopLoss: 'stopLoss' in changes ? changes.stopLoss ?? null : position.stopLoss,
        takeProfit: 'takeProfit' in changes ? changes.takeProfit ?? null : position.takeProfit,
      };
      const quote = await this.pricing.getLastQuote(position.pair);
      const problem = exitLevelProblem(position.direction, quote, levels);
      if (problem) throw new BadRequestException(problem);

      await manager.update(PositionEntity, positionId, levels);
      return { ...position, ...levels };
    });

    void this.realtime.positionsChanged(updated.userId, updated.id);
    return updated;
  }
}
