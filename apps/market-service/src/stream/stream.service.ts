import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Inject,
} from '@nestjs/common';
import { KafkaProducerService, NormalizedTick } from '@forexedge/kafka';
import type { MarketFeed } from '@forexedge/common';
import { IForexStreamProvider, MARKET_FEED_SETTING, STREAM_PROVIDER } from './interfaces/stream-provider.interface';
import { InstrumentRepository } from '../market/instrument.repository';
import { DOWN_AFTER_FAILURES, FEED_SOURCE, retryDelayMs, type FeedState, type FeedStatus } from './feed-status';

// Runs the configured feed's provider (one connection for all users) and publishes its ticks to Kafka.
// No feed configured: nothing starts. On a provider error the connection is dropped and retried with
// exponential backoff; ticks are published only while connected, so prices age out (order-service
// rejects them as stale). There is no fallback to another provider, simulated or otherwise.
@Injectable()
export class StreamService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StreamService.name);
  private status: FeedStatus;
  private failures = 0;
  private session = 0;           // ticks from an earlier (failed) connection are ignored
  private retryTimer: NodeJS.Timeout | null = null;
  private instruments: string[] = [];
  private stopped = false;

  constructor(
    @Inject(STREAM_PROVIDER)
    private readonly streamProvider: IForexStreamProvider | null,
    @Inject(MARKET_FEED_SETTING)
    private readonly feed: MarketFeed,
    private readonly kafkaProducer: KafkaProducerService,
    private readonly instrumentRepository: InstrumentRepository,
  ) {
    this.status = {
      feed, source: FEED_SOURCE[feed], simulated: feed === 'mock',
      state: 'off', since: new Date().toISOString(), lastTickAt: null, lastError: null,
    };
  }

  getStatus(): FeedStatus {
    return { ...this.status };
  }

  async onModuleInit(): Promise<void> {
    if (!this.streamProvider) {
      this.logger.warn('MARKET_FEED=none: no live market feed; no prices are published and every order is rejected');
      return;
    }
    if (this.feed === 'mock') this.logger.warn('MARKET_FEED=mock: publishing SIMULATED prices (not market data)');
    this.instruments = await this.instrumentRepository.findActiveInstruments();
    this.logger.log(`Loaded ${this.instruments.length} active instruments from DB`);
    await this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    await this.streamProvider?.disconnect();
  }

  private async connect(): Promise<void> {
    const provider = this.streamProvider;
    if (!provider || this.stopped) return;
    const session = ++this.session;
    try {
      await provider.connect(
        this.instruments,
        (tick: NormalizedTick) => this.handleTick(session, tick),
        (err: Error) => void this.handleFailure(session, err),
      );
      if (session !== this.session) return;
      this.failures = 0;
      this.setState('connected');
    } catch (err) {
      await this.handleFailure(session, err);
    }
  }

  private async handleTick(session: number, tick: NormalizedTick): Promise<void> {
    if (session !== this.session || this.status.state !== 'connected') return;
    // Publish to Kafka: all downstream processing (DB write, Redis cache) happens in consumers.
    await this.kafkaProducer.publishTick(tick);
    this.status.lastTickAt = new Date(tick.timestamp).toISOString();
  }

  private async handleFailure(session: number, err: unknown): Promise<void> {
    if (session !== this.session || this.stopped) return;
    this.session++; // stop publishing this connection's ticks at once
    this.failures++;
    const type = err instanceof Error ? err.name : typeof err;
    this.status.lastError = type;
    this.setState(this.failures >= DOWN_AFTER_FAILURES ? 'down' : 'degraded');
    const delay = retryDelayMs(this.failures);
    this.logger.error(`Market feed ${this.feed} failed (${type}, failure ${this.failures}); reconnecting in ${delay} ms`);
    try {
      await this.streamProvider?.disconnect();
    } catch (disconnectErr) {
      this.logger.warn(`Disconnect after a failure also failed: ${disconnectErr instanceof Error ? disconnectErr.name : 'unknown'}`);
    }
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
  }

  private setState(state: FeedState): void {
    if (this.status.state === state) return;
    this.status.state = state;
    this.status.since = new Date().toISOString();
  }
}
