// Margin for simulated positions. The formula is the live order-service's own,
// reused from @forexedge/common/money (only that file: the library barrel would pull
// in NestJS): margin (USD) = units x base->USD / leverage, where the leverage is the
// account's capped by instruments.max_leverage (1:100 capped at 1:20 for XAU/USD).
// Margin is reserved when an order is placed, at the price the order is decided on.
// There is no margin call or stop-out here: the backtester has none.
import { ContractSpec, marginRequiredUsd, quoteToUsdRate } from '@forexedge/common/money';

// The paper account's leverage (order-service's account default)
export const DEFAULT_ACCOUNT_LEVERAGE = 100;

export interface MarginInput {
  pair: string;           // 'EUR/USD'
  lots: number;
  spec: ContractSpec;     // lot size, pip size, max leverage from instruments
  pricePoints: number;    // the price it is valued at, in points
  priceDecimals: number;  // historical_price_scale
  accountLeverage?: number;
}

// Required margin in USD cents (marginRequiredUsd rounds to cents)
export function marginRequiredCents(input: MarginInput): bigint {
  const price = input.pricePoints / 10 ** input.priceDecimals;
  const usd = marginRequiredUsd(input.lots, input.spec, price, quoteToUsdRate(input.pair, price),
    input.accountLeverage ?? DEFAULT_ACCOUNT_LEVERAGE);
  return BigInt(Math.round(usd * 100));
}

export interface MarginCheck {
  ok: boolean;
  requiredCents: bigint;
  freeCents: bigint;
}

// An order fits when its margin is no more than the free margin (equity - margin in use)
export function checkMargin(requiredCents: bigint, equityCents: bigint, marginUsedCents: bigint): MarginCheck {
  const freeCents = equityCents - marginUsedCents;
  return { ok: requiredCents <= freeCents, requiredCents, freeCents };
}
