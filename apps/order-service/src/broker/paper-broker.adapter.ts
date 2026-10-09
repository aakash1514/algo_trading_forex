import { Injectable, Logger } from '@nestjs/common';
import { OrderEntity } from '@forexedge/database';
import { IForexBroker, BrokerFill, priceDecimals } from '@forexedge/common';
import { PricingService } from '../pricing/pricing.service';

@Injectable()
export class PaperBrokerAdapter implements IForexBroker {
  private readonly logger = new Logger(PaperBrokerAdapter.name);

  constructor(private readonly pricing: PricingService) {}

  async fillOrder(order: OrderEntity): Promise<BrokerFill> {
    // 1. Live price (written to Redis by market-service) and contract spec (DB)
    const [quote, spec] = await Promise.all([
      this.pricing.getQuote(order.pair),
      this.pricing.getSpec(order.pair),
    ]);

    // 2. Pick base price based on direction
    // LONG  → trader buys  → pays the ask (higher price, worse for trader)
    // SHORT → trader sells → gets the bid (lower price, worse for trader)
    const basePrice = order.direction === 'LONG' ? quote.ask : quote.bid;

    // 3. Apply random slippage 0–3 pips, always against the trader
    const slippagePips = Math.random() * 3; // 0 to 3 pips
    const slippage = slippagePips * spec.pipSize;

    // LONG:  slippage makes price higher (costs more to buy)
    // SHORT: slippage makes price lower  (get less when selling)
    const executedPrice =
      order.direction === 'LONG'
        ? basePrice + slippage
        : basePrice - slippage;

    // 4. Simulate broker latency (realistic paper trading feel)
    await this.delay(50);

    const decimals = priceDecimals(spec);
    this.logger.debug(
      `Filled ${order.direction} ${order.pair} @ ${executedPrice.toFixed(decimals)} ` +
      `(slippage: ${slippagePips.toFixed(2)} pips)`
    );

    return {
      executedPrice: parseFloat(executedPrice.toFixed(decimals)),
      executedAt: new Date(),
    };
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
