import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  KafkaConsumerService,
  REALTIME_TOPICS,
  SOCKET_EVENTS,
  parsePositionsUpdatedMessage,
} from '@forexedge/kafka';
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
      [REALTIME_TOPICS.POSITIONS_UPDATED],
      async (_topic, _partition, message) => {
        try {
          const payload = parsePositionsUpdatedMessage(message);

          if (payload.type === 'SNAPSHOT') {
            this.gateway.emitToUser(payload.userId, SOCKET_EVENTS.POSITIONS_SNAPSHOT, payload.positions);
          } else if (payload.type === 'PNL') {
            const { positionId, currentPrice, pipPnl, unrealizedPnl } = payload;
            this.gateway.emitToUser(payload.userId, SOCKET_EVENTS.POSITION_UPDATE, {
              positionId,
              currentPrice,
              pipPnl,
              unrealizedPnl,
            });
          }
        } catch (err) {
          this.logger.error('Failed to process positions.updated message', err);
        }
      },
    );
  }
}
