import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { KafkaConsumerService } from '@forexedge/kafka';
import { AppGateway } from '../gateway/app.gateway';

@Injectable()
export class PositionConsumer implements OnModuleInit {
  private readonly logger = new Logger(PositionConsumer.name);

  constructor(
    private readonly kafkaConsumer: KafkaConsumerService,
    private readonly gateway: AppGateway,
  ) {}

  async onModuleInit() {
    await this.kafkaConsumer.subscribe(
      'ws-gateway-position-consumer',
      ['positions.updated'],
      async (_topic, _partition, message) => {
        try {
          const payload = JSON.parse(message) as { userId?: string };
          const userId = payload.userId as string | undefined;
          if (!userId) return;
          this.gateway.emitToUser(userId, 'position:update', payload);
        } catch (err) {
          this.logger.error('Failed to process positions.updated message', err);
        }
      },
    );
  }
}