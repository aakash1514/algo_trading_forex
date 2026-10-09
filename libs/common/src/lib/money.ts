// Money math shared by order-service and domain-service. Contract specs
// (lot size, pip size) come from the instruments table; nothing here is
// specific to an asset class, so metals like XAU/USD (100 oz lots) just work.
//
// Identity used throughout: base->USD = price x quote->USD.

export interface ContractSpec {
  lotSize: number;  // units per 1.0 lot (100,000 for FX, 100 oz for XAU)
  pipSize: number;  // price increment of one pip (0.0001, 0.01, ...)
}

const round = (value: number, decimals: number) => {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
};

// Rate converting one unit of the pair's quote currency into USD.
// `crossRate` (quote->USD) is required only when USD is neither base nor quote.
export function quoteToUsdRate(pair: string, price: number, crossRate?: number): number {
  const [base, quote] = pair.split('/');
  if (quote === 'USD') return 1;
  if (base === 'USD') return 1 / price;
  if (crossRate === undefined) {
    throw new Error(`A ${quote}->USD rate is required to value ${pair}`);
  }
  return crossRate;
}

export function positionUnits(lots: number, spec: ContractSpec): number {
  return lots * spec.lotSize;
}

// margin (USD) = units x base->USD / leverage
export function marginRequiredUsd(
  lots: number, spec: ContractSpec, price: number, quoteToUsd: number, leverage: number,
): number {
  return round((positionUnits(lots, spec) * price * quoteToUsd) / leverage, 2);
}

// Value of one pip for the whole position, in USD (4 dp, matching the DB column).
export function pipValueUsd(lots: number, spec: ContractSpec, quoteToUsd: number): number {
  return round(positionUnits(lots, spec) * spec.pipSize * quoteToUsd, 4);
}

// Signed pips in the trader's favour.
export function pipsBetween(
  direction: 'LONG' | 'SHORT', openPrice: number, price: number, spec: Pick<ContractSpec, 'pipSize'>,
): number {
  const diff = direction === 'LONG' ? price - openPrice : openPrice - price;
  return round(diff / spec.pipSize, 2);
}

// Quote precision used for fills/display: one digit past the pip.
export function priceDecimals(spec: Pick<ContractSpec, 'pipSize'>): number {
  return Math.round(-Math.log10(spec.pipSize)) + 1;
}
