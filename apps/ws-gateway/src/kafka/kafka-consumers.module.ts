import { Module } from '@nestjs/common';
import { KafkaModule } from '@forexedge/kafka';
import { GatewayModule } from '../gateway/gateway.module';
import { PositionConsumer } from './position.consumer';
import { OrderConsumer } from './order.consumer';
import { TickConsumer } from './tick.consumer';
import { AccountConsumer } from './account.consumer';

@Module({
  imports: [
    KafkaModule,  // provides KafkaConsumerService to all consumers
    GatewayModule,
  ],
  providers: [PositionConsumer, OrderConsumer, TickConsumer, AccountConsumer],
})
export class KafkaConsumersModule {}