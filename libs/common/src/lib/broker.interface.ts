import { OrderEntity } from '@forexedge/database';

export interface BrokerFill {
  executedPrice: number;
  executedAt: Date;
}

export interface BrokerQuote {
  bid: number;
  ask: number;
}

export interface IForexBroker {
  // `quote`: the live quote the order was validated on (spread gate, margin).
  // A simulated broker fills from it; a real broker reports its own fill price.
  fillOrder(order: OrderEntity, quote: BrokerQuote): Promise<BrokerFill>;
}