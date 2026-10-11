import { COMMISSION_PIPS_PER_SIDE } from './trade.simulator';
import { Trade } from './strategies/strategy.interface';

// Money for backtest trades, in USD (the account currency), computed from integer
// points so that each amount is rounded once, to cents, from an exact fraction:
//
//   units      = lots x instruments.lot_size        (a whole number, or the run fails)
//   points     = direction x (exit - entry), and the round-trip commission in points
//   USD-quoted (EUR/USD, GBP/USD, XAU/USD)   usd = points x units / 10^decimals
//   USD-based  (USD/JPY)                     usd = points x units / ratePoints
//
// For a USD-based pair the quote-currency amount (points x units / 10^decimals) is
// converted at a rate of ratePoints / 10^decimals, so the 10^decimals cancel. A
// closed trade converts at its own exit fill (the bid for a long, the ask for a
// short); an open trade marked to market converts at the price it is valued at.
// Crosses (no USD leg) would need a second pair's history and are rejected.
//
// Rounding: to cents, half away from zero (the same as Postgres round(numeric)).

export type UsdLeg = 'quote' | 'base';

export interface MoneySpec {
  pair: string;           // DB format, 'EUR/USD'
  units: number;          // lots x lot_size
  priceDecimals: number;  // historical_price_scale
  pipPoints: number;      // points per pip (10 at every pair's scale)
}

export interface TradeMoney {
  units: number;
  grossUsd: number;
  commissionUsd: number;  // grossUsd - netUsd
  netUsd: number;
}

export function usdLeg(pair: string): UsdLeg {
  const [base, quote] = pair.split('/');
  if (quote === 'USD') return 'quote';
  if (base === 'USD') return 'base';
  throw new Error(`${pair} has no USD leg; valuing it needs a conversion pair's history`);
}

// lots x lot_size, which must be a whole number of units
export function positionUnits(lots: number, lotSize: number): number {
  const units = Math.round(lots * lotSize * 1e6) / 1e6;
  if (!Number.isInteger(units) || units <= 0) {
    throw new Error(`${lots} lots x lot size ${lotSize} = ${units} is not a whole, positive number of units`);
  }
  return units;
}

// Round-trip commission in points (0.7 pip per side = 14 points)
export function commissionPoints(pipPoints: number): number {
  const pts = Math.round(2 * COMMISSION_PIPS_PER_SIDE * pipPoints * 1e6) / 1e6;
  if (!Number.isInteger(pts)) throw new Error(`commission is not a whole number of points (${pts})`);
  return pts;
}

// numerator / denominator rounded half away from zero (denominator > 0)
export function roundHalfAwayFromZero(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('denominator must be positive');
  const sign = numerator < 0n ? -1n : 1n;
  const abs = numerator * sign;
  const q = abs / denominator;
  return sign * (2n * (abs % denominator) >= denominator ? q + 1n : q);
}

// A signed amount of points on the whole position -> USD cents.
// ratePoints is the conversion price in points (used only for a USD-based pair).
export function pointsToUsdCents(points: number, spec: MoneySpec, ratePoints: number): bigint {
  if (!Number.isInteger(points) || !Number.isInteger(ratePoints)) throw new Error('points must be integers');
  const numerator = BigInt(points) * BigInt(spec.units) * 100n;
  const denominator = usdLeg(spec.pair) === 'quote' ? 10n ** BigInt(spec.priceDecimals) : BigInt(ratePoints);
  return roundHalfAwayFromZero(numerator, denominator);
}

export const centsToUsd = (cents: bigint) => Number(cents) / 100;

// Gross, commission and net USD of a closed trade, converted at its exit fill
export function tradeMoney(trade: Pick<Trade, 'action' | 'entryPoints' | 'exitPoints'>, spec: MoneySpec): TradeMoney {
  const direction = trade.action === 'BUY' ? 1 : -1;
  const gross = direction * (trade.exitPoints - trade.entryPoints);
  const grossCents = pointsToUsdCents(gross, spec, trade.exitPoints);
  const netCents = pointsToUsdCents(gross - commissionPoints(spec.pipPoints), spec, trade.exitPoints);
  return {
    units: spec.units,
    grossUsd: centsToUsd(grossCents),
    commissionUsd: centsToUsd(grossCents - netCents),
    netUsd: centsToUsd(netCents),
  };
}
