import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  UserEntity,
  OrderEntity,
  PositionEntity,
  AccountSummaryEntity,
  InstrumentEntity,
  EconomicEventEntity,
} from '@forexedge/database';
import { BROKER_ADAPTER } from '@forexedge/common';
import { RedisModule } from '../redis/redis.module';
import { AuthModule } from '../auth/auth.module';
import { KafkaConsumerModule } from '../kafka/kafka.module';
import { PaperBrokerAdapter } from '../broker/paper-broker.adapter';
import { OrderService } from '../order/order.service';
import { OrderValidationService } from '../order/order-validation.service';
import { OrderController } from '../order/order.controller';
import { MarginEngineService } from '../order/margin-engine.service';
import { PositionService } from '../position/position.service';
import { PositionController } from '../position/position.controller';
import { AccountService } from '../account/account.service';
import { AccountController } from '../account/account.controller';
import { SessionConsumer } from '../kafka/session.consumer';
import { AppController } from './app.controller';
import { AppService } from './app.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get<string>('DB_HOST', 'localhost'),
        port: config.get<number>('DB_PORT', 15432),
        username: config.get<string>('DB_USER', 'forexedge'),
        password: config.get<string>('DB_PASS'),
        database: config.get<string>('DB_NAME', 'forexedge_db'),
        entities: [
          UserEntity, OrderEntity, PositionEntity,
          AccountSummaryEntity, InstrumentEntity, EconomicEventEntity,
        ],
        synchronize: false,
        ssl: config.get<string>('DB_SSL') === 'true'
          ? { rejectUnauthorized: false }
          : false,
      }),
      inject: [ConfigService],
    }),
    TypeOrmModule.forFeature([
      UserEntity,
      OrderEntity,
      PositionEntity,
      AccountSummaryEntity,
      InstrumentEntity,
      EconomicEventEntity,
    ]),
    RedisModule,
    AuthModule,
    KafkaConsumerModule,
  ],
  controllers: [
    AppController,
    OrderController,
    PositionController,
    AccountController,
  ],
  providers: [
    AppService,
    PaperBrokerAdapter,
    {
      provide: BROKER_ADAPTER,
      useClass: PaperBrokerAdapter,
    },
    OrderService,
    OrderValidationService,
    MarginEngineService,
    PositionService,
    AccountService,
    SessionConsumer,
  ],
})
export class AppModule {}