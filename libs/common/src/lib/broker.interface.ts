import { OrderEntity } from '@forexedge/database';

export interface BrokerFill {
  executedPrice: number;
  executedAt: Date;
}

export interface IForexBroker {
  fillOrder(order: OrderEntity): Promise<BrokerFill>;
}