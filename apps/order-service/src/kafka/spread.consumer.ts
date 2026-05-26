import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka, Consumer, EachMessagePayload } from 'kafkajs';
import { OrderValidationService } from '../order/order-validation.service';

export interface SpreadAlert {
  pair: string;
  spreadPips: number;
  timestamp: string;
}

@Injectable()
export class SpreadConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(SpreadConsumer.name);
  private consumer: Consumer;

  constructor(
    private readonly config: ConfigService,
    private readonly validationService: OrderValidationService,
  ) {
    const kafka = new Kafka({
      clientId: 'order-service-spread-monitor',
      brokers: [this.config.get<string>('KAFKA_BROKER', 'localhost:9092')],
    });

    this.consumer = kafka.consumer({
      groupId: 'order-service-spread-monitor',
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.consumer.connect();
      await this.consumer.subscribe({
        topic: 'forex.spread-alerts',
        fromBeginning: false,
      });

      await this.consumer.run({
        eachMessage: async (payload: EachMessagePayload) => {
          await this.handleSpreadAlert(payload);
        },
      });

      this.logger.log('Spread consumer started — group: order-service-spread-monitor');
    } catch (err) {
      this.logger.warn(`Spread consumer failed to start: ${this.getErrorMessage(err)}`);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.consumer.disconnect();
  }

  private async handleSpreadAlert(payload: EachMessagePayload): Promise<void> {
    try {
      const raw = payload.message.value?.toString();
      if (!raw) return;

      const alert = JSON.parse(raw) as SpreadAlert;
      this.validationService.updateSpreadCache(alert.pair, alert.spreadPips);

      this.logger.debug(`Spread updated — ${alert.pair}: ${alert.spreadPips} pips`);
    } catch (err) {
      this.logger.error(`Error processing spread alert: ${this.getErrorMessage(err)}`);
    }
  }

  private getErrorMessage(err: unknown): string {
    if (err instanceof Error) {
      return err.message;
    }
    return String(err);
  }
}