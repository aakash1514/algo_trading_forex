import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { FOREX_TICKS_TOPIC, KafkaConsumerService, parseTickMessage } from '@forexedge/kafka';
import { AppGateway } from '../gateway/app.gateway';

@Injectable()
export class TickConsumer implements OnModuleInit {
  private readonly logger = new Logger(TickConsumer.name);

  constructor(
    private readonly kafkaConsumer: KafkaConsumerService,
    private readonly gateway: AppGateway,
  ) {}

  async onModuleInit() {
    await this.kafkaConsumer.subscribe(
      'ws-gateway-tick-consumer',
      [FOREX_TICKS_TOPIC],
      async (_topic, _partition, message) => {
        try {
          const payload = parseTickMessage(message);
          this.gateway.emitTick(payload.instrument, payload);
        } catch (err) {
          this.logger.error('Failed to process forex.ticks message', err);
        }
      },
    );
  }
}