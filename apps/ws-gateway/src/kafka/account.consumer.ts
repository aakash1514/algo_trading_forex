import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  KafkaConsumerService,
  REALTIME_TOPICS,
  SOCKET_EVENTS,
  parseAccountUpdatedMessage,
} from '@forexedge/kafka';
import { AppGateway } from '../gateway/app.gateway';

@Injectable()
export class AccountConsumer implements OnModuleInit {
  private readonly logger = new Logger(AccountConsumer.name);

  constructor(
    private readonly kafkaConsumer: KafkaConsumerService,
    private readonly gateway: AppGateway,
  ) {}

  async onModuleInit() {
    await this.kafkaConsumer.subscribe(
      'ws-gateway-account-consumer',
      [REALTIME_TOPICS.ACCOUNTS_UPDATED],
      async (_topic, _partition, message) => {
        try {
          const payload = parseAccountUpdatedMessage(message);
          this.gateway.emitToUser(payload.userId, SOCKET_EVENTS.ACCOUNT_UPDATE, payload.summary);
        } catch (err) {
          this.logger.error('Failed to process accounts.updated message', err);
        }
      },
    );
  }
}
