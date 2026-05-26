import { Injectable, Inject, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { OrderEntity } from '@forexedge/database';
import { IForexBroker, BrokerFill } from '@forexedge/common';
import { REDIS_CLIENT } from '../redis/redis.module';

@Injectable()
export class PaperBrokerAdapter implements IForexBroker {
  private readonly logger = new Logger(PaperBrokerAdapter.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async fillOrder(order: OrderEntity): Promise<BrokerFill> {
    // 1. Read current price from Redis
    // market-service writes ticks as JSON to key: price:{pair}
    const redisKey = `price:${order.pair.replace('/', '_')}`;
    const raw = await this.redis.get(redisKey);

    if (!raw) {
      throw new Error(`No tick data for ${order.pair} — is market-service running?`);
    }

    const tick = JSON.parse(raw) as { bid: number; ask: number; mid: number };

    // 2. Pick base price based on direction
    // LONG  → trader buys  → pays the ask (higher price, worse for trader)
    // SHORT → trader sells → gets the bid (lower price, worse for trader)
    const basePrice = order.direction === 'LONG' ? tick.ask : tick.bid;

    // 3. Apply random slippage 0–3 pips, always against the trader
    // JPY pairs have pip = 0.01, all others pip = 0.0001
    const isJpy = order.pair.includes('JPY');
    const pipSize = isJpy ? 0.01 : 0.0001;
    const slippagePips = Math.random() * 3; // 0 to 3 pips
    const slippage = slippagePips * pipSize;

    // LONG:  slippage makes price higher (costs more to buy)
    // SHORT: slippage makes price lower  (get less when selling)
    const executedPrice =
      order.direction === 'LONG'
        ? basePrice + slippage
        : basePrice - slippage;

    // 4. Simulate broker latency (realistic paper trading feel)
    await this.delay(50);

    this.logger.debug(
      `Filled ${order.direction} ${order.pair} @ ${executedPrice.toFixed(isJpy ? 3 : 5)} ` +
      `(slippage: ${slippagePips.toFixed(2)} pips)`
    );

    return {
      executedPrice: parseFloat(executedPrice.toFixed(isJpy ? 3 : 5)),
      executedAt: new Date(),
    };
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}