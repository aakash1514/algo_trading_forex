import {
  Injectable, Logger, Inject, BadRequestException, ConflictException, NotFoundException
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import {
  OrderEntity, OrderStatus, PositionEntity, AccountSummaryEntity
} from '@forexedge/database';
import { IForexBroker } from '@forexedge/common';
import { BROKER_ADAPTER, assertUserId, sessionLabel, type InstrumentKind } from '@forexedge/common';
import { OrderValidationService } from './order-validation.service';
import type { OrderRequest, SubmitOrderDto } from './dto/submit-order.dto';
import { instrumentToPair } from '../common/instrument';
import { RealtimePublisher } from '../realtime/realtime-publisher.service';
import { PricingService, PriceUnavailableError } from '../pricing/pricing.service';
import { MarginEngineService } from './margin-engine.service';
import { OpenPairsIndex } from '../position/open-pairs.index';
import { MarketHoursPolicy, marketClosedReason } from '../market/market-hours.policy';
import { Kafka, Producer } from 'kafkajs';
import { ORDERS_LIFECYCLE_TOPIC, type OrderLifecycleMessage } from '@forexedge/kafka';

// Valid FSM transitions — key: current state, value: allowed next states
const VALID_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  DRAFT:     ['PENDING', 'REJECTED'],
  PENDING:   ['OPEN', 'REJECTED', 'CANCELLED'],
  SUBMITTED: ['OPEN', 'REJECTED', 'CANCELLED'],
  OPEN:      ['CLOSED', 'CANCELLED'],
  CLOSED:    [],
  REJECTED:  [],
  CANCELLED: [],
};

@Injectable()
export class OrderService {
  private readonly logger = new Logger(OrderService.name);
  private producer: Producer;

  constructor(
    @InjectRepository(OrderEntity)
    private readonly orderRepo: Repository<OrderEntity>,
    @InjectRepository(AccountSummaryEntity)
    private readonly accountRepo: Repository<AccountSummaryEntity>,
    private readonly dataSource: DataSource,
    @Inject(BROKER_ADAPTER)
    private readonly broker: IForexBroker,
    private readonly validationService: OrderValidationService,
    private readonly marginEngine: MarginEngineService,
    private readonly realtime: RealtimePublisher,
    private readonly pricing: PricingService,
    private readonly openPairs: OpenPairsIndex,
    private readonly marketHours: MarketHoursPolicy,
  ) {
    // Kafka producer — wired up in Step 10
    // Declared here so OrderService doesn't need to change in Step 10
    const kafka = new Kafka({ brokers: ['localhost:9092'] });
    this.producer = kafka.producer();
    this.producer.connect().catch(err =>
      this.logger.warn(`Kafka producer not available: ${this.getErrorMessage(err)}`)
    );
  }

  // ─── Submit Order ──────────────────────────────────────────────────────────
  // Idempotency keys are globally unique in the DB. A key reused by the same
  // user returns that user's order; another user's key is a conflict and must
  // never return (or reveal) the other user's order.
  private async findIdempotent(userId: string, idempotencyKey: string): Promise<OrderEntity | null> {
    const existing = await this.orderRepo.findOne({ where: { idempotencyKey } });
    if (existing && existing.userId !== userId) {
      throw new ConflictException('Idempotency key already used');
    }
    return existing;
  }

  async idempotencyKeyExists(userId: string, idempotencyKey: string): Promise<boolean> {
    assertUserId(userId);
    return !!(await this.findIdempotent(userId, idempotencyKey));
  }

  async submitOrder(
    userId: string,
    body: SubmitOrderDto,
    idempotencyKey: string,
  ): Promise<OrderEntity> {
    assertUserId(userId);
    const dto: OrderRequest = { ...body, pair: instrumentToPair(body.instrument) };

    // Step 1: Idempotency check (scoped to the user)
    const existing = await this.findIdempotent(userId, idempotencyKey);
    if (existing) {
      this.logger.log(`Idempotency hit — returning existing order ${existing.id}`);
      return existing;
    }

    // Step 2: Create order in DRAFT state
    let order = this.orderRepo.create({
      idempotencyKey,
      userId,
      instrument: dto.instrument,
      pair: dto.pair,
      direction: dto.direction,
      orderType: dto.orderType,
      lots: dto.lots,
      requestedPrice: dto.requestedPrice ?? null,
      stopLoss: dto.stopLoss ?? null,
      takeProfit: dto.takeProfit ?? null,
      // From the shared market clock: correct right after a restart, and
      // OFF_HOURS whenever the FX market is closed
      sessionOpened: sessionLabel(),
      status: 'DRAFT',
    });
    order = await this.orderRepo.save(order);

    // Wrap post-DRAFT flow so errors never leave an order stuck in DRAFT
    try {
      // Step 2b: market hours first. While a market is closed the feed is silent
      // and there is no live quote, so this must come before fetching one or the
      // trader would be told "no live price" instead of "market closed".
      const closed = await this.marketClosedReason(dto.pair);
      if (closed) return await this.transitionState(order, 'REJECTED', closed);

      // Step 3: Run validation gates, checking margin at the live entry price
      let quote: { bid: number; ask: number };
      try {
        quote = await this.pricing.getQuote(dto.pair);
      } catch (err) {
        if (!(err instanceof PriceUnavailableError)) throw err;
        return await this.transitionState(order, 'REJECTED', err.message);
      }
      const entryPrice = dto.direction === 'LONG' ? quote.ask : quote.bid;
      const validation = await this.validationService.validate(
        userId,
        dto,
        quote,
        () => this.marginEngine.canOpenPosition(userId, dto.pair, dto.lots, entryPrice),
      );

      if (!validation.valid) {
        order = await this.transitionState(order, 'REJECTED', validation.reason);
        return order;
      }

      // Step 4: DRAFT → PENDING
      order = await this.transitionState(order, 'PENDING');

      // Step 5: Call broker adapter
      let fill;
      try {
        fill = await this.broker.fillOrder(order, quote);
      } catch (err) {
        this.logger.error(`Broker fill failed: ${this.getErrorMessage(err)}`);
        order = await this.transitionState(
          order,
          'REJECTED',
          `Broker error: ${this.getErrorMessage(err)}`
        );
        return order;
      }

      // Step 6: PENDING → OPEN + record fill details
      order = await this.dataSource.transaction(async manager => {
        order.executedPrice = fill.executedPrice;
        order.openedAt = fill.executedAt;
        order.submittedAt = fill.executedAt;

        // Pip value and margin at the executed price
        const account = await manager.findOne(AccountSummaryEntity, {
          where: { userId }
        });
        const { pipValue, marginRequired: marginUsed } = await this.marginEngine.valuePosition(
          order.pair, Number(order.lots), fill.executedPrice, account?.leverage,
        );

        order.pipValue = pipValue;
        order.marginUsed = marginUsed;

        const updated = await manager.save(OrderEntity, {
          ...order,
          status: 'OPEN',
          openedAt: fill.executedAt,
        });

        // Step 7: Create position record
        await manager.save(PositionEntity, {
          orderId: order.id,
          userId,
          instrument: order.instrument,
          pair: order.pair,
          direction: order.direction,
          lots: order.lots,
          openPrice: fill.executedPrice,
          currentPrice: fill.executedPrice,
          pipValue,
          marginUsed,
          stopLoss: order.stopLoss,
          takeProfit: order.takeProfit,
          isOpen: true,
          openedAt: fill.executedAt,
        });

        // Step 8: add the margin to the account. A relative update: the tick
        // consumer moves unrealized_pnl concurrently, and writing back the row
        // read above would undo its changes (a lost update).
        await manager
          .createQueryBuilder()
          .update(AccountSummaryEntity)
          .set({ marginUsed: () => 'margin_used + :addedMargin' })
          .where('user_id = :userId', { userId })
          .setParameters({ addedMargin: marginUsed })
          .execute();

        return updated;
      });

      // Step 9: after the commit — the tick consumer's open-pairs index, then
      // Kafka (fire and forget)
      this.openPairs.opened(order.pair);
      this.publishLifecycleEvent(order).catch(err =>
        this.logger.warn(`Kafka publish failed: ${this.getErrorMessage(err)}`)
      );
      void this.realtime.positionsChanged(userId);

      return order;
    } catch (err) {
      this.logger.error(
        `Unexpected error in submitOrder: ${this.getErrorMessage(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
      try {
        order = await this.transitionState(
          order,
          'REJECTED',
          `Internal error: ${this.getErrorMessage(err)}`
        );
      } catch {
        // Transition may fail if order already moved — return as-is
      }
      return order;
    }
  }

  // ─── FSM Transition ────────────────────────────────────────────────────────
  private async transitionState(
    order: OrderEntity,
    newState: OrderStatus,
    reason?: string,
  ): Promise<OrderEntity> {
    const allowed = VALID_TRANSITIONS[order.status];

    if (!allowed.includes(newState)) {
      throw new BadRequestException(
        `Invalid transition: ${order.status} → ${newState}`
      );
    }

    const updated = await this.dataSource.transaction(async manager => {
      const updates: Partial<OrderEntity> = { status: newState };

      if (reason) updates.rejectionReason = reason;
      if (newState === 'PENDING') updates.submittedAt = new Date();
      if (newState === 'CLOSED') updates.closedAt = new Date();

      await manager.update(OrderEntity, order.id, updates);

      const reloaded = await manager.findOne(OrderEntity, { where: { id: order.id } });
      if (!reloaded) throw new Error(`Order ${order.id} not found after transition`);
      return reloaded;
    });

    // Fire and forget, only after the transaction committed
    this.publishLifecycleEvent(updated).catch(err =>
      this.logger.warn(`Kafka lifecycle publish failed: ${this.getErrorMessage(err)}`)
    );
    return updated;
  }

  // ─── Cancel Order ──────────────────────────────────────────────────────────
  async cancelOrder(userId: string, orderId: string): Promise<OrderEntity> {
    assertUserId(userId);
    const order = await this.orderRepo.findOne({
      where: { id: orderId, userId },
    });

    if (!order) {
      throw new NotFoundException(`Order ${orderId} not found`);
    }

    if (!['PENDING', 'SUBMITTED'].includes(order.status)) {
      throw new ConflictException(
        `Cannot cancel order in status ${order.status} — only PENDING or SUBMITTED orders can be cancelled`
      );
    }

    return this.transitionState(order, 'CANCELLED');
  }

  // ─── Queries ───────────────────────────────────────────────────────────────
  async getOrder(userId: string, orderId: string): Promise<OrderEntity> {
    assertUserId(userId);
    const order = await this.orderRepo.findOne({
      where: { id: orderId, userId },
    });
    if (!order) throw new NotFoundException(`Order ${orderId} not found`);
    return order;
  }

  async getOrders(
    userId: string,
    filters: {
      status?: OrderStatus;
      pair?: string;
      from?: Date;
      to?: Date;
      limit?: number;
    },
  ): Promise<OrderEntity[]> {
    assertUserId(userId);
    const qb = this.orderRepo
      .createQueryBuilder('o')
      .where('o.user_id = :userId', { userId })
      .orderBy('o.created_at', 'DESC')
      .take(filters.limit ?? 50);

    if (filters.status) qb.andWhere('o.status = :status', { status: filters.status });
    if (filters.pair)   qb.andWhere('o.pair = :pair', { pair: filters.pair });
    if (filters.from)   qb.andWhere('o.created_at >= :from', { from: filters.from });
    if (filters.to)     qb.andWhere('o.created_at <= :to', { to: filters.to });

    return qb.getMany();
  }

  // The rejection reason if the pair's market is closed now, else null. An
  // unknown pair is left to the instrument gate.
  private async marketClosedReason(pair: string): Promise<string | null> {
    let kind: InstrumentKind;
    try {
      kind = await this.pricing.getInstrumentKind(pair);
    } catch {
      return null;
    }
    const status = this.marketHours.status(kind);
    return status.open ? null : marketClosedReason(pair, status);
  }

  // ─── Kafka ─────────────────────────────────────────────────────────────────
  private async publishLifecycleEvent(order: OrderEntity): Promise<void> {
    const message: OrderLifecycleMessage = {
      orderId: order.id,
      userId: order.userId,
      status: order.status,
      pair: order.pair,
      direction: order.direction,
      lots: Number(order.lots),
      executedPrice: order.executedPrice === null ? null : Number(order.executedPrice),
      timestamp: new Date().toISOString(),
    };
    await this.producer.send({
      topic: ORDERS_LIFECYCLE_TOPIC,
      messages: [{ key: order.id, value: JSON.stringify(message) }],
    });
  }

  private getErrorMessage(err: unknown): string {
    if (err instanceof Error) {
      return err.message;
    }
    return String(err);
  }
}