// Money math shared by order-service and domain-service. Contract specs
// (lot size, pip size) come from the instruments table; nothing here is
// specific to an asset class, so metals like XAU/USD (100 oz lots) just work.
//
// Identity used throughout: base->USD = price x quote->USD.

export interface ContractSpec {
  lotSize: number;  // units per 1.0 lot (100,000 for FX, 100 oz for XAU)
  pipSize: number;  // price increment of one pip (0.0001, 0.01, ...)
  // instruments.max_leverage: the instrument's leverage cap (20 for XAU/USD);
  // null means the account's leverage applies unchanged.
  maxLeverage: number | null;
}

// The instruments-row fields a spec is built from. node-pg returns NUMERIC as
// strings unless an entity transformer converted them, so both are accepted.
export interface InstrumentSpecRow {
  lotSize: number | string;
  pipSize: number | string;
  maxLeverage: number | string | null;
}

export function toContractSpec(row: InstrumentSpecRow): ContractSpec {
  return {
    lotSize: Number(row.lotSize),
    pipSize: Number(row.pipSize),
    maxLeverage: row.maxLeverage === null ? null : Number(row.maxLeverage),
  };
}

// Rounding mode for every money value here: half up (toward +infinity) at the
// given decimals, applied to the double (Math.round(v x 10^d) / 10^d). Margins
// and pip values are positive, so for them this is the familiar half-up:
// 912.125 -> 912.13. Inputs that aren't exact in binary round as stored.
const round = (value: number, decimals: number) => {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
};

// Leverage actually applied to a position: the account's, capped by the
// instrument's maximum (e.g. 1:100 account, gold capped at 1:20 -> 20).
export function effectiveLeverage(accountLeverage: number, maxLeverage: number | null): number {
  return maxLeverage === null ? accountLeverage : Math.min(accountLeverage, maxLeverage);
}

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

// margin (USD) = units x base->USD / effective leverage, where `accountLeverage`
// is capped by the instrument's max_leverage.
export function marginRequiredUsd(
  lots: number, spec: ContractSpec, price: number, quoteToUsd: number, accountLeverage: number,
): number {
  const leverage = effectiveLeverage(accountLeverage, spec.maxLeverage);
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
