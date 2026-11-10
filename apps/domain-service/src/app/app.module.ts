import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import {
  InstrumentEntity,
  SwapRateEntity,
  EconomicEventEntity,
} from '@forexedge/database';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';
import { HealthModule, redisCheck, sqlCheck } from '@forexedge/common';
import { KafkaModule, kafkaHealthCheck } from '@forexedge/kafka';
import { REDIS_CLIENT, RedisModule } from '../redis/redis.module';
import { PipCalculatorModule } from '../pip-calculator/pip-calculator.module';
import { SessionClockModule } from '../session-clock/session-clock.module';
import { SpreadMonitorModule } from '../spread-monitor/spread-monitor.module';
import { SwapCalculationModule } from '../swap-calculation/swap-calculation.module';
import { MarginEngineModule } from '../margin-engine/margin-engine.module';
import { EconomicCalendarModule } from '../economic-calendar/economic-calendar.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';


@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
     useFactory: (config: ConfigService) => ({
      type: 'postgres',
      host: config.get<string>('DB_HOST', 'localhost'),
      port: config.get<number>('DB_PORT', 15432),
      username: config.get<string>('DB_USER'),
      password: config.get<string>('DB_PASS'),
      database: config.get<string>('DB_NAME'),
      entities: [InstrumentEntity, SwapRateEntity, EconomicEventEntity],
      synchronize: false,
      ssl: config.get<string>('DB_SSL') === 'true'
        ? { rejectUnauthorized: false }
        : false,
    }),
    }),
    KafkaModule,
    RedisModule,
    PipCalculatorModule,
    SessionClockModule,
    SpreadMonitorModule,
    SwapCalculationModule,
    MarginEngineModule,
    EconomicCalendarModule,
    HealthModule.forRoot({
      inject: [DataSource, REDIS_CLIENT, ConfigService],
      useFactory: (db: DataSource, redis: Redis, config: ConfigService) => ({
        db: sqlCheck(db),
        redis: redisCheck(redis),
        kafka: kafkaHealthCheck(config.get<string>('KAFKA_BROKER', 'localhost:9092')),
      }),
    }),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}