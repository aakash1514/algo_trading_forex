import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { KafkaConsumerService, REALTIME_TOPICS, SOCKET_EVENTS, parseOrderLifecycleMessage } from '@forexedge/kafka';
import { AppGateway } from '../gateway/app.gateway';

@Injectable()
export class OrderConsumer implements OnModuleInit {
  private readonly logger = new Logger(OrderConsumer.name);

  constructor(
    private readonly kafkaConsumer: KafkaConsumerService,
    private readonly gateway: AppGateway,
  ) {}

  async onModuleInit() {
    await this.kafkaConsumer.subscribe(
      'ws-gateway-order-consumer',
      [REALTIME_TOPICS.ORDERS_LIFECYCLE],
      async (_topic, _partition, message) => {
        try {
          // orders.lifecycle is keyed by orderId; the payload carries the userId
          const payload = parseOrderLifecycleMessage(message);
          this.gateway.emitToUser(payload.userId, SOCKET_EVENTS.ORDER_UPDATE, payload);
        } catch (err) {
          this.logger.error('Failed to process orders.lifecycle message', err);
        }
      },
    );
  }
}