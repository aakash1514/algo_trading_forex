import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { KafkaConsumerService, KAFKA_TOPICS, parseTickMessage } from '@forexedge/kafka';
import { InjectRedis } from '../redis/redis.decorator';
import Redis from 'ioredis';

// How long to keep price in Redis before considering it stale
// If no tick arrives for 2 seconds, price is expired
// Prevents serving stale prices during connectivity issues
const PRICE_CACHE_TTL_SECONDS = 2;

@Injectable()
export class TickCacheWriterService implements OnModuleInit {
  private readonly logger = new Logger(TickCacheWriterService.name);

  constructor(
    private readonly kafkaConsumer: KafkaConsumerService,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.kafkaConsumer.subscribe(
      'market-service-cache-writer',      // different group ID — independent offset
      [KAFKA_TOPICS.FOREX_TICKS],
      this.handleMessage.bind(this),
    );

    this.logger.log('Tick cache writer consumer started');
  }

  private async handleMessage(
    _topic: string,
    _partition: number,
    message: string,
  ): Promise<void> {
    const tick = parseTickMessage(message);

    // Key: price:EUR_USD
    // Value: full NormalizedTick as JSON
    // TTL: 2 seconds — auto-expires if stream stops
    const value = JSON.stringify(tick);
    await this.redis.setex(`price:${tick.instrument}`, PRICE_CACHE_TTL_SECONDS, value);
    // Last known price, no expiry: a reference for validating SL/TP levels
    // while the market is closed. Never used to fill orders.
    await this.redis.set(`price:last:${tick.instrument}`, value);
  }
}