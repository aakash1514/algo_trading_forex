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
import { PositionService } from '../position/position.service';
import { AccountService } from '../account/account.service';
import { OrderValidationService } from '../order/order-validation.service';
import { RealtimePublisher } from '../realtime/realtime-publisher.service';
import { PricingService } from '../pricing/pricing.service';
import { OpenPairsIndex } from '../position/open-pairs.index';

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
    PositionService,
    AccountService,
    OrderValidationService,
    RealtimePublisher,
    PricingService,
    OpenPairsIndex,
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
  exports: [PositionService, AccountService, OrderValidationService, RealtimePublisher, PricingService, OpenPairsIndex],
})
export class KafkaConsumerModule {}