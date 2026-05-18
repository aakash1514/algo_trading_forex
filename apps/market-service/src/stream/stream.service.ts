import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Inject,
} from '@nestjs/common';
import { KafkaProducerService, NormalizedTick } from '@forexedge/kafka';
import { IForexStreamProvider, STREAM_PROVIDER } from './interfaces/stream-provider.interface';
import { InstrumentRepository } from '../market/instrument.repository';

@Injectable()
export class StreamService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StreamService.name);

  constructor(
    @Inject(STREAM_PROVIDER)
    private readonly streamProvider: IForexStreamProvider,
    private readonly kafkaProducer: KafkaProducerService,
    private readonly instrumentRepository: InstrumentRepository,
  ) {}

  async onModuleInit(): Promise<void> {
    // Load active instruments from DB (the 28 pairs we seeded in Phase 1)
    const instruments = await this.instrumentRepository.findActiveInstruments();
    this.logger.log(`Loaded ${instruments.length} active instruments from DB`);

    await this.streamProvider.connect(
      instruments,
      (tick: NormalizedTick) => this.handleTick(tick),
      (err: Error) => this.handleError(err),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.streamProvider.disconnect();
  }

  private async handleTick(tick: NormalizedTick): Promise<void> {
    // Publish to Kafka — this is the ONLY thing StreamService does with a tick.
    // All downstream processing (DB write, Redis cache) happens in consumers.
    await this.kafkaProducer.publishTick(tick);
  }

  private handleError(err: Error): void {
    this.logger.error(`Stream provider error: ${err.message}`);
    // In production: implement reconnect logic with exponential backoff
    // For now: log and let the service continue
  }
}