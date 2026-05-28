import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { KafkaConsumerService } from '@forexedge/kafka';
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
      ['orders.lifecycle'],
      async (_topic, _partition, message) => {
        try {
          const payload = JSON.parse(message) as { userId?: string };
          // orders.lifecycle key is orderId, but payload contains userId
          const userId = payload.userId as string | undefined;
          if (!userId) return;
          this.gateway.emitToUser(userId, 'order:update', payload);
        } catch (err) {
          this.logger.error('Failed to process orders.lifecycle message', err);
        }
      },
    );
  }
}