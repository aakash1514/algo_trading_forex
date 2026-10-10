import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { PositionEntity, AccountSummaryEntity, OrderEntity } from '@forexedge/database';
import { CloseReason } from '@forexedge/database';
import { RealtimePublisher } from '../realtime/realtime-publisher.service';
import { assertUserId, pipValueUsd, pipsBetween } from '@forexedge/common';
import { PricingService } from '../pricing/pricing.service';
import { OpenPairsIndex } from './open-pairs.index';
import type { TickMessage } from '@forexedge/kafka';

// The forex.ticks fields position processing uses (TickMessage is the contract)
export type NormalizedTick = Pick<TickMessage, 'pair' | 'bid' | 'ask' | 'mid' | 'timestamp'>;

interface PendingExit {
  reason: 'STOP_LOSS' | 'TAKE_PROFIT';
  price: number;
}

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

  // Stop-loss/take-profit exits that triggered but couldn't be booked yet,
  // keyed by position id, retried on every tick batch at their trigger price.
  // In memory: lost on restart (the next tick beyond the level re-triggers).
  private readonly pendingExits = new Map<string, PendingExit>();

  constructor(
    @InjectRepository(PositionEntity)
    private readonly positionRepo: Repository<PositionEntity>,
    @InjectRepository(OrderEntity)
    private readonly orderRepo: Repository<OrderEntity>,
    private readonly dataSource: DataSource,
    private readonly realtime: RealtimePublisher,
    private readonly pricing: PricingService,
    private readonly openPairs: OpenPairsIndex,
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
  // without touching the DB (OpenPairsIndex). For the rest, stop-loss and
  // take-profit are checked against EVERY tick, so a level touched by one tick
  // and left by the next still triggers, while the P&L mark is written once per
  // pair from the latest tick: intermediate marks would be overwritten anyway.
  // Returns the users whose positions were touched (for the margin-call check).
  //
  // The batch's offsets are committed when this returns, so its ticks are never
  // re-delivered. A triggered exit that can't be booked yet (no USD conversion
  // rate for a cross pair) is therefore kept in pendingExits at its trigger price
  // and retried on every batch, not dropped; only P&L marks are skipped then.
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
        await this.processPairTicks(pair, pairTicks, affectedUsers, streamMids);
      } catch (err) {
        this.logger.error(
          `Dropped ${pairTicks.length} ${pair} tick(s); their offsets are committed with the batch: ${errorMessage(err)}`,
        );
      }
    }
    return affectedUsers;
  }

  private async processPairTicks(
    pair: string, pairTicks: NormalizedTick[], affectedUsers: Set<string>, streamMids: ReadonlyMap<string, number>,
  ): Promise<void> {
    let positions = (await this.positionRepo.find({ where: { pair, isOpen: true } }))
      .filter((p) => !this.pendingExits.has(p.id));
    for (const position of positions) affectedUsers.add(position.userId);

    for (const tick of pairTicks) {
      const stillOpen: PositionEntity[] = [];
      for (const position of positions) {
        const trigger = this.exitTrigger(position, tick.mid);
        if (!trigger) {
          stillOpen.push(position);
          continue;
        }
        // Fills at this tick's price, even if it gapped past the level
        await this.exitAt(position.id, { reason: trigger, price: tick.mid }, streamMids);
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

  // Books a triggered stop-loss/take-profit, or parks it in pendingExits when it
  // can't be booked yet. Positions closed meanwhile by another path are ignored.
  private async exitAt(
    positionId: string, exit: PendingExit, streamMids: ReadonlyMap<string, number>,
  ): Promise<void> {
    try {
      await this.closePosition(positionId, exit.reason, exit.price, streamMids);
      this.pendingExits.delete(positionId);
    } catch (err) {
      if (err instanceof PositionAlreadyClosedError) {
        this.pendingExits.delete(positionId);
        return;
      }
      if (!this.pendingExits.has(positionId)) {
        this.logger.warn(
          `${exit.reason} triggered for position ${positionId} at ${exit.price}; booking deferred: ${errorMessage(err)}`,
        );
      }
      this.pendingExits.set(positionId, exit);
    }
  }

  private async retryPendingExits(streamMids: ReadonlyMap<string, number>): Promise<void> {
    for (const [positionId, exit] of [...this.pendingExits]) {
      await this.exitAt(positionId, exit, streamMids);
    }
  }

  // STOP_LOSS / TAKE_PROFIT when `price` reaches the position's level, else null.
  private exitTrigger(position: PositionEntity, price: number): 'STOP_LOSS' | 'TAKE_PROFIT' | null {
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

  // Writes the position's P&L at `currentPrice` and moves the account's
  // unrealized P&L by the difference.
  private async markToMarket(
    position: PositionEntity, currentPrice: number, streamMids?: ReadonlyMap<string, number>,
  ): Promise<void> {
    const { pipPnl, pipValue, pnl: unrealizedPnl } = await this.valueAt(position, currentPrice, streamMids);

    // The position was loaded before the awaits above, so it may have been
    // closed meanwhile. Re-read it under a row lock (closePosition takes the
    // same lock) and skip it if it's no longer open; otherwise this write would
    // overwrite the exit price and P&L of a closed position and add its P&L
    // back into the account. The account delta uses the locked row's value.
    const updated = await this.dataSource.transaction(async manager => {
      const locked = await manager.findOne(PositionEntity, {
        where: { id: position.id, isOpen: true },
        lock: { mode: 'pessimistic_write' },
      });
      if (!locked) return false;

      await manager.update(PositionEntity, locked.id, {
        currentPrice,
        pipPnl,
        pipValue,
        unrealizedPnl,
      });

      // Direct update so tick-frequency changes reach account_summary
      await manager
        .createQueryBuilder()
        .update(AccountSummaryEntity)
        .set({ unrealizedPnl: () => 'unrealized_pnl - :previousPnl + :nextPnl' })
        .where('user_id = :userId', { userId: locked.userId })
        .setParameters({ previousPnl: Number(locked.unrealizedPnl), nextPnl: unrealizedPnl })
        .execute();
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
        await manager.update(PositionEntity, position.id, {
          swapAccrued: Number(position.swapAccrued) + swapAmount,
        });

        // Adjust account balance by swap amount (negative swap = cost to trader)
        await manager
          .createQueryBuilder()
          .update(AccountSummaryEntity)
          .set({ balance: () => `balance + ${swapAmount}` })
          .where('user_id = :userId', { userId: position.userId })
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
      // Row lock: serializes with the tick-driven P&L update for this position
      const position = await manager.findOne(PositionEntity, {
        where: { id: positionId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!position) throw new Error(`Position ${positionId} not found`);
      if (!position.isOpen) throw new PositionAlreadyClosedError(positionId);

      const { pipPnl, pnl: realizedPnl } = await this.valueAt(position, closingPrice, streamMids);

      // Close the position
      await manager.update(PositionEntity, positionId, {
        isOpen: false,
        closedAt: new Date(),
        closeReason: reason,
        currentPrice: closingPrice,
        pipPnl,
        realizedPnl,
        unrealizedPnl: 0,
      });

      // Update order status to CLOSED. executed_price stays the entry fill;
      // the exit price lives on the position (current_price at close).
      await manager.update(OrderEntity, position.orderId, {
        status: 'CLOSED',
        closedAt: new Date(),
      });

      // Account: realize the P&L, release the margin, remove this position's
      // unrealized P&L. Relative updates only: other positions of the same user
      // move unrealized_pnl concurrently, and writing back a row read earlier
      // would discard those changes (a lost update). The position row is locked,
      // so its unrealized_pnl here is the value last added to the account.
      await manager
        .createQueryBuilder()
        .update(AccountSummaryEntity)
        .set({
          balance: () => 'balance + :realizedPnl',
          marginUsed: () => 'GREATEST(0, margin_used - :releasedMargin)',
          unrealizedPnl: () => 'unrealized_pnl - :removedPnl',
        })
        .where('user_id = :userId', { userId: position.userId })
        .setParameters({
          realizedPnl,
          releasedMargin: Number(position.marginUsed),
          removedPnl: Number(position.unrealizedPnl),
        })
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

  // Manual close at the live market: a LONG sells at the bid, a SHORT buys at the ask.
  async closeAtMarket(userId: string, positionId: string): Promise<PositionEntity> {
    const position = await this.getPosition(userId, positionId);
    const quote = await this.pricing.getQuote(position.pair);
    const closingPrice = position.direction === 'LONG' ? quote.bid : quote.ask;
    return this.closePosition(positionId, 'MANUAL', closingPrice);
  }
}