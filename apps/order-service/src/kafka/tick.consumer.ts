import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka, Consumer, EachMessagePayload } from 'kafkajs';
import { PositionService, NormalizedTick } from '../position/position.service';
import { AccountService } from '../account/account.service';

@Injectable()
export class TickConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(TickConsumer.name);
  private consumer: Consumer;

  constructor(
    private readonly config: ConfigService,
    private readonly positionService: PositionService,
    private readonly accountService: AccountService,
  ) {
    const kafka = new Kafka({
      clientId: 'order-service-tick-processor',
      brokers: [this.config.get<string>('KAFKA_BROKER', 'localhost:9092')],
    });

    this.consumer = kafka.consumer({
      groupId: 'order-service-tick-processor',
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.consumer.connect();
      await this.consumer.subscribe({
        topic: 'forex.ticks',
        fromBeginning: false,
      });

      await this.consumer.run({
        eachMessage: async (payload: EachMessagePayload) => {
          await this.handleTick(payload);
        },
      });

      this.logger.log('Tick consumer started — group: order-service-tick-processor');
    } catch (err) {
      this.logger.warn(`Tick consumer failed to start: ${this.getErrorMessage(err)}`);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.consumer.disconnect();
  }

  private async handleTick(payload: EachMessagePayload): Promise<void> {
    try {
      const raw = payload.message.value?.toString();
      if (!raw) return;

      const tick = JSON.parse(raw) as NormalizedTick;

      // Recalculate P&L for all open positions on this pair
      await this.positionService.recalculatePositions(tick);

      // After recalculation, check margin levels for affected users
      const affectedPositions = await this.positionService['positionRepo'].find({
        where: { pair: tick.pair, isOpen: true },
        select: ['userId'],
      });

      const uniqueUserIds = [...new Set(affectedPositions.map(p => p.userId))];

      for (const userId of uniqueUserIds) {
        await this.accountService.checkMarginCall(userId);
      }
    } catch (err) {
      this.logger.error(`Error processing tick: ${this.getErrorMessage(err)}`);
    }
  }

  private getErrorMessage(err: unknown): string {
    if (err instanceof Error) {
      return err.message;
    }
    return String(err);
  }
}