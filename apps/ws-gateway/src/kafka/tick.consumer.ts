import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { KafkaConsumerService } from '@forexedge/kafka';
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
      ['forex.ticks'],
      async (_topic, _partition, message) => {
        try {
          const payload = JSON.parse(message) as { instrument?: string };
          const instrument = payload.instrument;
          if (!instrument) return;
          this.gateway.emitTick(instrument, payload);
        } catch (err) {
          this.logger.error('Failed to process forex.ticks message', err);
        }
      },
    );
  }
}