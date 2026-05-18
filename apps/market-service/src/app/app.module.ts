import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InstrumentEntity } from '@forexedge/database';
import { KafkaModule } from '@forexedge/kafka';
import { RedisModule } from '../redis/redis.module';
import { MarketModule } from '../market/market.module';
import { StreamModule } from '../stream/stream.module';
import { TickProcessorModule } from '../tick-processor/tick-processor.module';

@Module({
  imports: [
    // Config — loads .env, available everywhere
    ConfigModule.forRoot({ isGlobal: true }),

    // Database — only InstrumentEntity needed in market-service
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get<string>('DB_HOST', 'localhost'),
        port: config.get<number>('DB_PORT', 15432),
        username: config.get<string>('DB_USER'),
        password: config.get<string>('DB_PASS'),
        database: config.get<string>('DB_NAME'),
        entities: [InstrumentEntity],
        synchronize: false,   // NEVER true — we use migrations
        ssl: false,
      }),
      inject: [ConfigService],
    }),

    RedisModule,        // @Global — InjectRedis() available everywhere
    KafkaModule,        // @Global — KafkaProducerService + KafkaConsumerService everywhere
    MarketModule,       // REST endpoints + InstrumentRepository
    StreamModule,       // OANDA/Mock stream → Kafka producer
    TickProcessorModule, // Kafka consumers → TimescaleDB + Redis
  ],
})
export class AppModule {}