import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { PositionEntity, AccountSummaryEntity, OrderEntity } from '@forexedge/database';
import { CloseReason } from '@forexedge/database';
import { RealtimePublisher } from '../realtime/realtime-publisher.service';
import { assertUserId, pipValueUsd, pipsBetween } from '@forexedge/common';
import { PricingService } from '../pricing/pricing.service';
import { OpenPairsIndex } from './open-pairs.index';

export interface NormalizedTick {
  pair: string;
  bid: number;
  ask: number;
  mid: number;
  timestamp: string;
}

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
  ) {}

  // P&L of a position at `price`, converted to USD at the current quote->USD
  // rate (exact for USD-base and cross pairs, not just USD-quote ones).
  async valueAt(position: PositionEntity, price: number): Promise<{ pipPnl: number; pipValue: number; pnl: number }> {
    const spec = await this.pricing.getSpec(position.pair);
    const quoteToUsd = await this.pricing.quoteToUsd(position.pair, price);
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
  async processTicks(ticks: NormalizedTick[]): Promise<Set<string>> {
    const affectedUsers = new Set<string>();
    const byPair = new Map<string, NormalizedTick[]>();
    for (const tick of ticks) {
      if (!this.openPairs.has(tick.pair)) continue;
      const list = byPair.get(tick.pair) ?? [];
      list.push(tick);
      byPair.set(tick.pair, list);
    }

    // Each pair is processed independently: one pair failing (e.g. a cross pair
    // whose USD conversion rate isn't in Redis yet) must not skip the stop-loss
    // checks and P&L marks of every other pair in the batch.
    for (const [pair, pairTicks] of byPair) {
      try {
        await this.processPairTicks(pair, pairTicks, affectedUsers);
      } catch (err) {
        this.logger.error(`Skipped ${pairTicks.length} ${pair} tick(s): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return affectedUsers;
  }

  private async processPairTicks(pair: string, pairTicks: NormalizedTick[], affectedUsers: Set<string>): Promise<void> {
    let positions = await this.positionRepo.find({ where: { pair, isOpen: true } });
    for (const position of positions) affectedUsers.add(position.userId);

    for (const tick of pairTicks) {
      const stillOpen: PositionEntity[] = [];
      for (const position of positions) {
        const trigger = this.exitTrigger(position, tick.mid);
        if (!trigger) {
          stillOpen.push(position);
          continue;
        }
        try {
          // Fills at this tick's price, even if it gapped past the level
          await this.closePosition(position.id, trigger, tick.mid);
        } catch (err) {
          // Closed by another path (manual close) since it was loaded: nothing to do
          if (!(err instanceof PositionAlreadyClosedError)) throw err;
        }
      }
      positions = stillOpen;
    }

    const latest = pairTicks[pairTicks.length - 1];
    for (const position of positions) {
      await this.markToMarket(position, latest.mid);
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
  private async markToMarket(position: PositionEntity, currentPrice: number): Promise<void> {
    const { pipPnl, pipValue, pnl: unrealizedPnl } = await this.valueAt(position, currentPrice);

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
  ): Promise<PositionEntity> {
    const closed = await this.dataSource.transaction(async manager => {
      // Row lock: serializes with the tick-driven P&L update for this position
      const position = await manager.findOne(PositionEntity, {
        where: { id: positionId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!position) throw new Error(`Position ${positionId} not found`);
      if (!position.isOpen) throw new PositionAlreadyClosedError(positionId);

      const { pipPnl, pnl: realizedPnl } = await this.valueAt(position, closingPrice);

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

      // Update account: release margin, realize P&L, zero out this position's unrealized
      const account = await manager.findOne(AccountSummaryEntity, {
        where: { userId: position.userId },
      });

      if (account) {
        await manager.update(AccountSummaryEntity, account.id, {
          balance: Number(account.balance) + realizedPnl,
          marginUsed: Math.max(0, Number(account.marginUsed) - Number(position.marginUsed)),
          unrealizedPnl: Number(account.unrealizedPnl) - Number(position.unrealizedPnl),
        });
      }

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