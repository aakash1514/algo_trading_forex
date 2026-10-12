import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { KafkaConsumerService, KAFKA_TOPICS, parseTickMessage } from '@forexedge/kafka';
import { insertLiveTick } from '@forexedge/database';

@Injectable()
export class TickDbWriterService implements OnModuleInit {
  private readonly logger = new Logger(TickDbWriterService.name);

  constructor(
    private readonly kafkaConsumer: KafkaConsumerService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.kafkaConsumer.subscribe(
      'market-service-db-writer',         // consumer group ID
      [KAFKA_TOPICS.FOREX_TICKS],         // topics to subscribe to
      this.handleMessage.bind(this),      // handler function
    );

    this.logger.log('Tick DB writer consumer started');
  }

  private async handleMessage(
    _topic: string,
    _partition: number,
    message: string,
  ): Promise<void> {
    const tick = parseTickMessage(message);

    // Live ticks go to the ticks hypertable only, never historical_* (see insertLiveTick).
    await insertLiveTick(this.dataSource, tick);
  }
}