import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BacktestRunEntity } from '@forexedge/database';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from '../auth/auth.module';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';
import { HealthModule, redisCheck, sqlCheck } from '@forexedge/common';
import { kafkaHealthCheck } from '@forexedge/kafka';
import { REDIS_CLIENT, RedisModule } from '../redis/redis.module';
import { GatewayModule } from '../gateway/gateway.module';
import { KafkaConsumersModule } from '../kafka/kafka-consumers.module';
import { BacktestQueueModule } from '../backtest/backtest-queue.module';
import { BacktestModule } from '../backtest/backtest.module';
import { BACKTEST_RESULT_STORE, BacktestResultStore } from '../backtest/result-store';
import { UserEntity } from '@forexedge/database';

@Module({
  imports: [
    // Must stay first: TypeOrmModule.forRoot below reads process.env at import time.
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      username: process.env.DB_USER ?? 'forexedge',
      password: process.env.DB_PASS ?? 'forexedge',
      database: process.env.DB_NAME ?? 'forexedge_db',
      entities: [BacktestRunEntity, UserEntity],
      synchronize: false,
      ssl: process.env.DB_SSL === 'true'
        ? { rejectUnauthorized: false }
        : false,
    }),
    AuthModule,
    RedisModule,
    GatewayModule,
    KafkaConsumersModule,
    BacktestQueueModule,
    BacktestModule,
    HealthModule.forRoot({
      imports: [BacktestModule],
      inject: [DataSource, REDIS_CLIENT, ConfigService, BACKTEST_RESULT_STORE],
      useFactory: (db: DataSource, redis: Redis, config: ConfigService, results: BacktestResultStore) => ({
        db: sqlCheck(db),
        redis: redisCheck(redis),
        kafka: kafkaHealthCheck(config.get<string>('KAFKA_BROKER', 'localhost:9092')),
        storage: () => results.check(),
      }),
    }),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}