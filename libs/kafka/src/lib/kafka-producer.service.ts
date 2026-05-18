import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Partitioners, Producer } from 'kafkajs';
import { createKafkaClient, ensureTopicsExist } from './kafka.client';
import { NormalizedTick } from './interfaces/tick.interface';

export const KAFKA_TOPICS = {
  FOREX_TICKS: 'forex.ticks',
} as const;

@Injectable()
export class KafkaProducerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaProducerService.name);
  private producer!: Producer;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const broker = this.config.get<string>('KAFKA_BROKER', 'localhost:9092');

    // Step 1: ensure topic exists before producer connects
    await ensureTopicsExist(broker, [KAFKA_TOPICS.FOREX_TICKS]);
    this.logger.log('Kafka topics verified');

    // Step 2: connect producer
    const kafka = createKafkaClient(broker);
    this.producer = kafka.producer({
      createPartitioner: Partitioners.LegacyPartitioner,
      allowAutoTopicCreation: true,
      transactionTimeout: 30000,
    });

    await this.producer.connect();
    this.logger.log('Kafka producer connected');

    // Step 3: small buffer for KRaft metadata propagation
    await this.delay(1000);
  }

  async publishTick(tick: NormalizedTick): Promise<void> {
    await this.producer.send({
      topic: KAFKA_TOPICS.FOREX_TICKS,
      messages: [
        {
          key: tick.instrument,
          value: JSON.stringify(tick),
          timestamp: tick.timestamp.getTime().toString(),
        },
      ],
    });
  }

  async publish(topic: string, key: string, value: unknown): Promise<void> {
    await this.producer.send({
      topic,
      messages: [{ key, value: JSON.stringify(value) }],
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.producer.disconnect();
    this.logger.log('Kafka producer disconnected');
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}