import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka, Consumer, EachMessagePayload } from 'kafkajs';

export interface SessionEvent {
  session: string;   // 'SYDNEY' | 'TOKYO' | 'LONDON' | 'NEW_YORK'
  status: 'OPEN' | 'CLOSED';
  timestamp: string;
}

@Injectable()
export class SessionConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(SessionConsumer.name);
  private consumer: Consumer;

  // In-memory cache of currently open sessions
  // OrderService reads this when stamping session_opened on an order
  private activeSessions = new Set<string>();

  constructor(private readonly config: ConfigService) {
    const kafka = new Kafka({
      clientId: 'order-service-session-monitor',
      brokers: [this.config.get<string>('KAFKA_BROKER', 'localhost:9092')],
    });

    this.consumer = kafka.consumer({
      groupId: 'order-service-session-monitor',
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.consumer.connect();
      await this.consumer.subscribe({
        topic: 'forex.sessions',
        fromBeginning: false,
      });

      await this.consumer.run({
        eachMessage: async (payload: EachMessagePayload) => {
          await this.handleSessionEvent(payload);
        },
      });

      this.logger.log('Session consumer started — group: order-service-session-monitor');
    } catch (err) {
      this.logger.warn(`Session consumer failed to start: ${this.getErrorMessage(err)}`);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.consumer.disconnect();
  }

  // Called by OrderService to stamp session_opened on new orders
  getActiveSession(): string {
    if (this.activeSessions.size === 0) return 'OFF_HOURS';
    return [...this.activeSessions].join(',');
  }

  private async handleSessionEvent(payload: EachMessagePayload): Promise<void> {
    try {
      const raw = payload.message.value?.toString();
      if (!raw) return;

      const event = JSON.parse(raw) as SessionEvent;

      if (event.status === 'OPEN') {
        this.activeSessions.add(event.session);
      } else {
        this.activeSessions.delete(event.session);
      }

      this.logger.debug(
        `Session ${event.session} ${event.status} — active: [${[...this.activeSessions].join(', ')}]`,
      );
    } catch (err) {
      this.logger.error(`Error processing session event: ${this.getErrorMessage(err)}`);
    }
  }

  private getErrorMessage(err: unknown): string {
    if (err instanceof Error) {
      return err.message;
    }
    return String(err);
  }
}