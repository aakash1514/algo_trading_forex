import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parseMarketFeed, type MarketFeed } from '@forexedge/common';
import { StreamService } from './stream.service';
import { MockStreamProvider, parseMockStreamWhenClosed } from './providers/mock-stream.provider';
import { IForexStreamProvider, MARKET_FEED_SETTING, STREAM_PROVIDER } from './interfaces/stream-provider.interface';
import { FeedStatusController } from './feed-status.controller';
import { MarketModule } from '../market/market.module';
import { InstrumentRepository } from '../market/instrument.repository';

// The provider for the configured feed, or null for no feed. The simulated provider is built only for
// MARKET_FEED=mock; no other setting (including the default) can reach it.
export function createStreamProvider(
  feed: MarketFeed,
  makeMock: () => IForexStreamProvider,
): IForexStreamProvider | null {
  switch (feed) {
    case 'mock':
      return makeMock();
    case 'none':
      return null;
  }
}

// USE_MOCK_DATA used to select the simulated feed (default true). It is no longer read: an old .env
// must not silently turn the simulator back on, so say what replaced it.
export function warnIfLegacyFeedFlag(useMockData: string | undefined, logger = new Logger('StreamModule')): void {
  if (useMockData !== undefined) {
    logger.warn('USE_MOCK_DATA is no longer read; the feed is MARKET_FEED (none by default, mock for simulated prices)');
  }
}

@Module({
  imports: [MarketModule],
  controllers: [FeedStatusController],
  providers: [
    {
      provide: MARKET_FEED_SETTING,
      useFactory: (config: ConfigService) => parseMarketFeed(config.get<string>('MARKET_FEED')),
      inject: [ConfigService],
    },
    {
      provide: STREAM_PROVIDER,
      useFactory: (config: ConfigService, feed: MarketFeed, instruments: InstrumentRepository) => {
        warnIfLegacyFeedFlag(config.get<string>('USE_MOCK_DATA'));
        return createStreamProvider(feed, () => {
          // Precision and typical spread per instrument come from the DB
          const streamWhenClosed = parseMockStreamWhenClosed(config.get<string>('MOCK_STREAM_WHEN_CLOSED'));
          return new MockStreamProvider(() => instruments.findQuoteSpecs(), undefined, undefined, streamWhenClosed);
        });
      },
      inject: [ConfigService, MARKET_FEED_SETTING, InstrumentRepository],
    },
    StreamService,
  ],
})
export class StreamModule {}
