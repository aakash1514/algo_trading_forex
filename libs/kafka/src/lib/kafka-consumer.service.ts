import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Consumer, EachMessagePayload } from 'kafkajs';
import { createKafkaClient } from './kafka.client';

export type MessageHandler = (
  topic: string,
  partition: number,
  message: string,
) => Promise<void>;

@Injectable()
export class KafkaConsumerService implements OnModuleDestroy {
  private readonly logger = new Logger(KafkaConsumerService.name);
  private readonly consumers: Consumer[] = [];

  constructor(private readonly config: ConfigService) {}

  async subscribe(
    groupId: string,
    topics: string[],
    handler: MessageHandler,
  ): Promise<void> {
    const broker = this.config.get<string>('KAFKA_BROKER', 'localhost:9092');
    const kafka = createKafkaClient(broker);

    const consumer = kafka.consumer({ groupId });
    await consumer.connect();

    for (const topic of topics) {
      await consumer.subscribe({ topic, fromBeginning: false });
    }

    await consumer.run({
      eachMessage: async (payload: EachMessagePayload) => {
        const { topic, partition, message } = payload;
        const value = message.value?.toString();
        if (!value) return;

        try {
          await handler(topic, partition, value);
        } catch (err) {
          this.logger.error(
            `Error handling message on ${topic}[${partition}]: ${err}`,
          );
        }
      },
    });

    this.consumers.push(consumer);
    this.logger.log(
      `Consumer group [${groupId}] subscribed to [${topics.join(', ')}]`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    for (const consumer of this.consumers) {
      await consumer.disconnect();
    }
    this.logger.log('All Kafka consumers disconnected');
  }
}