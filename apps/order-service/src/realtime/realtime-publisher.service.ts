import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Partitioners, type Producer } from 'kafkajs';
import { PositionEntity } from '@forexedge/database';
import {
  createKafkaClient,
  ensureTopicsExist,
  REALTIME_TOPICS,
  type AccountUpdatedMessage,
  type PositionPnlMessage,
  type PositionsSnapshotMessage,
} from '@forexedge/kafka';
import { AccountService } from '../account/account.service';
import { KeyedThrottle } from './keyed-throttle';

// Tick-driven updates are capped at ~1 message per second per position/account.
const THROTTLE_MS = 1_000;

// Publishes per-user real-time updates for ws-gateway to relay.
// Callers must invoke these only after the related DB transaction committed.
@Injectable()
export class RealtimePublisher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RealtimePublisher.name);
  private readonly throttle = new KeyedThrottle(THROTTLE_MS);
  private producer?: Producer;

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(PositionEntity)
    private readonly positionRepo: Repository<PositionEntity>,
    private readonly accountService: AccountService,
  ) {}

  async onModuleInit(): Promise<void> {
    const broker = this.config.get<string>('KAFKA_BROKER', 'localhost:9092');
    try {
      // Topics must exist before the producer connects (KRaft cold start).
      await ensureTopicsExist(broker, [REALTIME_TOPICS.POSITIONS_UPDATED, REALTIME_TOPICS.ACCOUNTS_UPDATED]);
      const producer = createKafkaClient(broker).producer({
        createPartitioner: Partitioners.LegacyPartitioner,
      });
      await producer.connect();
      this.producer = producer;
      this.logger.log('Realtime publisher connected');
    } catch (err) {
      this.logger.warn(`Realtime publisher unavailable: ${errorMessage(err)}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.throttle.clear();
    await this.producer?.disconnect();
  }

  // Tick-driven P&L for one position, plus the user's account (both throttled).
  positionPnl(position: Pick<PositionEntity, 'id' | 'userId'>, currentPrice: number, pipPnl: number, unrealizedPnl: number): void {
    const message: PositionPnlMessage = {
      type: 'PNL',
      userId: position.userId,
      positionId: position.id,
      currentPrice,
      pipPnl,
      unrealizedPnl,
    };
    this.throttle.run(`position:${position.id}`, () => this.send(REALTIME_TOPICS.POSITIONS_UPDATED, message.userId, message));
    this.throttle.run(`account:${position.userId}`, () => void this.publishAccount(position.userId));
  }

  // After a position opens or closes: full open-position snapshot + account, immediately.
  async positionsChanged(userId: string, closedPositionId?: string): Promise<void> {
    if (closedPositionId) this.throttle.forget(`position:${closedPositionId}`);
    try {
      const positions = await this.positionRepo.find({
        where: { userId, isOpen: true },
        order: { openedAt: 'DESC' },
      });
      const snapshot: PositionsSnapshotMessage = { type: 'SNAPSHOT', userId, positions };
      await this.send(REALTIME_TOPICS.POSITIONS_UPDATED, userId, snapshot);
    } catch (err) {
      this.logger.warn(`Positions snapshot failed for ${userId}: ${errorMessage(err)}`);
    }
    // Supersedes any pending throttled account update.
    this.throttle.forget(`account:${userId}`);
    await this.publishAccount(userId);
  }

  private async publishAccount(userId: string): Promise<void> {
    try {
      const { balance, marginUsed, unrealizedPnl, leverage, equity, freeMargin, marginLevel } =
        await this.accountService.getAccountSummary(userId);
      const message: AccountUpdatedMessage = {
        userId,
        summary: { balance, marginUsed, unrealizedPnl, leverage, equity, freeMargin, marginLevel },
      };
      await this.send(REALTIME_TOPICS.ACCOUNTS_UPDATED, userId, message);
    } catch (err) {
      this.logger.warn(`Account update failed for ${userId}: ${errorMessage(err)}`);
    }
  }

  private async send(topic: string, key: string, value: object): Promise<void> {
    if (!this.producer) return;
    try {
      await this.producer.send({ topic, messages: [{ key, value: JSON.stringify(value) }] });
    } catch (err) {
      this.logger.warn(`Publish to ${topic} failed: ${errorMessage(err)}`);
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
