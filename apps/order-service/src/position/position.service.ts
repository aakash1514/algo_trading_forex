import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { PositionEntity, AccountSummaryEntity, OrderEntity } from '@forexedge/database';
import { CloseReason } from '@forexedge/database';
import { RealtimePublisher } from '../realtime/realtime-publisher.service';
import { assertUserId, pipValueUsd, pipsBetween } from '@forexedge/common';
import { PricingService } from '../pricing/pricing.service';

export interface NormalizedTick {
  pair: string;
  bid: number;
  ask: number;
  mid: number;
  timestamp: string;
}

@Injectable()
export class PositionService {
  private readonly logger = new Logger(PositionService.name);

  constructor(
    @InjectRepository(PositionEntity)
    private readonly positionRepo: Repository<PositionEntity>,
    @InjectRepository(AccountSummaryEntity)
    private readonly accountRepo: Repository<AccountSummaryEntity>,
    @InjectRepository(OrderEntity)
    private readonly orderRepo: Repository<OrderEntity>,
    private readonly dataSource: DataSource,
    private readonly realtime: RealtimePublisher,
    private readonly pricing: PricingService,
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

  // ─── Called by Kafka tick consumer ─────────────────────────────────────────
  async recalculatePositions(tick: NormalizedTick): Promise<void> {
    const positions = await this.positionRepo.find({
      where: { pair: tick.pair, isOpen: true },
    });

    if (positions.length === 0) return;

    for (const position of positions) {
      const currentPrice = tick.mid;
      const { pipPnl, pipValue, pnl: unrealizedPnl } = await this.valueAt(position, currentPrice);

      // Check stop-loss and take-profit before saving
      const slHit =
        position.stopLoss !== null &&
        ((position.direction === 'LONG' && currentPrice <= Number(position.stopLoss)) ||
          (position.direction === 'SHORT' && currentPrice >= Number(position.stopLoss)));

      const tpHit =
        position.takeProfit !== null &&
        ((position.direction === 'LONG' && currentPrice >= Number(position.takeProfit)) ||
          (position.direction === 'SHORT' && currentPrice <= Number(position.takeProfit)));

      if (slHit) {
        await this.closePosition(position.id, 'STOP_LOSS', currentPrice);
        continue;
      }

      if (tpHit) {
        await this.closePosition(position.id, 'TAKE_PROFIT', currentPrice);
        continue;
      }

      // Update position with latest P&L
      await this.positionRepo.update(position.id, {
        currentPrice,
        pipPnl,
        pipValue,
        unrealizedPnl,
      });

      // Update account unrealized_pnl — write-through handled by AccountService
      // Here we do a direct update so tick-frequency changes are captured
      await this.accountRepo
        .createQueryBuilder()
        .update(AccountSummaryEntity)
        .set({
          unrealizedPnl: () =>
            `unrealized_pnl - ${Number(position.unrealizedPnl)} + ${unrealizedPnl}`,
        })
        .where('user_id = :userId', { userId: position.userId })
        .execute();

      this.realtime.positionPnl(position, currentPrice, pipPnl, unrealizedPnl);
    }
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
      const position = await manager.findOne(PositionEntity, {
        where: { id: positionId },
      });

      if (!position) throw new Error(`Position ${positionId} not found`);
      if (!position.isOpen) throw new Error(`Position ${positionId} is already closed`);

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

    // Publish only after the transaction committed.
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