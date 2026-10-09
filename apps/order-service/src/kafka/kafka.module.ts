import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  OrderEntity,
  PositionEntity,
  AccountSummaryEntity,
  InstrumentEntity,
  EconomicEventEntity,
} from '@forexedge/database';
import { TickConsumer } from './tick.consumer';
import { SpreadConsumer } from './spread.consumer';
import { SessionConsumer } from './session.consumer';
import { PositionService } from '../position/position.service';
import { AccountService } from '../account/account.service';
import { OrderValidationService } from '../order/order-validation.service';
import { RealtimePublisher } from '../realtime/realtime-publisher.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      OrderEntity,
      PositionEntity,
      AccountSummaryEntity,
      InstrumentEntity,
      EconomicEventEntity,
    ]),
  ],
  providers: [
    TickConsumer,
    SpreadConsumer,
    SessionConsumer,
    PositionService,
    AccountService,
    OrderValidationService,
    RealtimePublisher,
    {
      provide: 'KAFKA_CONFIG',
      useFactory: (config: ConfigService) => ({
        brokers: [config.get<string>('KAFKA_BROKER', 'localhost:9092')],
        clientId: 'order-service',
      }),
      inject: [ConfigService],
    },
  ],
  // Single instances shared with AppModule (controllers, OrderService).
  exports: [SessionConsumer, PositionService, AccountService, OrderValidationService, RealtimePublisher],
})
export class KafkaConsumerModule {}