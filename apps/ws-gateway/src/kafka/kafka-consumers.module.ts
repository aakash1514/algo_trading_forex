import { Module } from '@nestjs/common';
import { KafkaModule } from '@forexedge/kafka';
import { GatewayModule } from '../gateway/gateway.module';
import { PositionConsumer } from './position.consumer';
import { OrderConsumer } from './order.consumer';
import { TickConsumer } from './tick.consumer';

@Module({
  imports: [
    KafkaModule,  // provides KafkaConsumerService to all three consumers
    GatewayModule,
  ],
  providers: [PositionConsumer, OrderConsumer, TickConsumer],
})
export class KafkaConsumersModule {}