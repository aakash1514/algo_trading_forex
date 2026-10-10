import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { KafkaConsumerService, KAFKA_TOPICS, parseTickMessage } from '@forexedge/kafka';

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

    // Raw SQL INSERT — no TypeORM overhead
    // $1, $2... are parameterized to prevent SQL injection
    await this.dataSource.query(
      `INSERT INTO ticks (time, instrument, pair, bid, ask, mid, spread, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        new Date(tick.timestamp),   // Kafka serializes Date as string, parse it back
        tick.instrument,
        tick.pair,
        tick.bid,
        tick.ask,
        tick.mid,
        tick.spread,
        tick.source,
      ],
    );
  }
}