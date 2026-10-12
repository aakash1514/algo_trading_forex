import { Injectable, Logger } from '@nestjs/common';
import { priceProblem, type MarketFeed, type PriceStamp } from '@forexedge/common';

// Which prices order-service may trade on: the configured MARKET_FEED's sources, no older than their
// maximum age (libs/common market-feed.ts). Used for every quote an order fills at (PricingService) and
// every tick that may trigger a stop-loss/take-profit or mark P&L (TickConsumer), so a stale, missing or
// simulated-when-not-configured price never moves money. Built by KafkaConsumerModule from MARKET_FEED.
@Injectable()
export class PriceFeedPolicy {
  private readonly logger = new Logger(PriceFeedPolicy.name);

  constructor(readonly feed: MarketFeed, private readonly now: () => number = Date.now) {
    if (this.feed === 'none') this.logger.log('MARKET_FEED=none: no live prices, every order is rejected');
    if (this.feed === 'mock') this.logger.warn('MARKET_FEED=mock: trading on SIMULATED prices (development only)');
  }

  // Why this price may not be traded now, or null if it may. `pair` in slash format.
  problem(pair: string, price: PriceStamp): string | null {
    return priceProblem(pair, price, this.feed, this.now());
  }
}
