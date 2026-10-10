import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka, Consumer, EachBatchPayload } from 'kafkajs';
import { FOREX_TICKS_TOPIC, parseTickMessage } from '@forexedge/kafka';
import { PositionService, NormalizedTick } from '../position/position.service';
import { StopOutService } from '../account/stop-out.service';

// Consumes forex.ticks in batches. Per batch: stop-loss/take-profit see every
// tick, P&L is marked once per pair from the latest tick, and each affected
// user gets one margin-call check (PositionService.processTicks). Pairs with no
// open positions cost nothing, so the consumer keeps up with the feed instead
// of falling minutes behind it.
@Injectable()
export class TickConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  // Lag (messages behind the partition end) above which a warning is logged,
  // at most once per LAG_LOG_INTERVAL_MS. ~2 s of the mock feed.
  static readonly LAG_WARN_MESSAGES = 100;
  static readonly LAG_LOG_INTERVAL_MS = 30_000;

  private readonly logger = new Logger(TickConsumer.name);
  private consumer: Consumer;
  private lastLagLog = 0;

  constructor(
    private readonly config: ConfigService,
    private readonly positionService: PositionService,
    private readonly stopOut: StopOutService,
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
        topic: FOREX_TICKS_TOPIC,
        fromBeginning: false,
      });

      await this.consumer.run({
        // Offsets are resolved when the batch handler returns
        eachBatchAutoResolve: true,
        eachBatch: async (payload: EachBatchPayload) => {
          await this.handleBatch(payload);
        },
      });

      this.logger.log('Tick consumer started — group: order-service-tick-processor (batched)');
    } catch (err) {
      this.logger.warn(`Tick consumer failed to start: ${this.getErrorMessage(err)}`);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.consumer.disconnect();
  }

  async handleBatch({ batch, heartbeat }: Pick<EachBatchPayload, 'batch' | 'heartbeat'>): Promise<void> {
    const ticks: NormalizedTick[] = [];
    for (const message of batch.messages) {
      const raw = message.value?.toString();
      if (!raw) continue;
      try {
        ticks.push(parseTickMessage(raw));
      } catch (err) {
        this.logger.warn(`Skipping tick at offset ${message.offset}: ${this.getErrorMessage(err)}`);
      }
    }

    try {
      const users = await this.positionService.processTicks(ticks);
      for (const userId of users) {
        await this.stopOut.check(userId);
      }
    } catch (err) {
      this.logger.error(`Error processing ${ticks.length} ticks: ${this.getErrorMessage(err)}`);
    }

    await heartbeat();
    this.logLag(batch.highWatermark, batch.messages.at(-1)?.offset);
  }

  private logLag(highWatermark: string, lastOffset: string | undefined): void {
    if (lastOffset === undefined) return;
    const lag = Number(highWatermark) - Number(lastOffset) - 1;
    const now = Date.now();
    if (lag > TickConsumer.LAG_WARN_MESSAGES && now - this.lastLagLog > TickConsumer.LAG_LOG_INTERVAL_MS) {
      this.lastLagLog = now;
      this.logger.warn(`Tick consumer is ${lag} messages behind forex.ticks`);
    }
  }

  private getErrorMessage(err: unknown): string {
    if (err instanceof Error) {
      return err.message;
    }
    return String(err);
  }
}
