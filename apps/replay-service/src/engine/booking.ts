// Money for replay positions, through @forexedge/trading-sim (the backtester's
// rules): units from instruments.lot_size, net USD with the round-trip commission,
// USD/JPY converted at the exit price, whole cents.
import { MoneySpec, Side, tradeMoney } from '@forexedge/trading-sim';
import { PairContext } from '../history/replay-history';

export function moneySpec(ctx: PairContext, units: number): MoneySpec {
  return { pair: ctx.pair, units, priceDecimals: ctx.priceDecimals, pipPoints: ctx.pipPoints };
}

// Net realized USD of a close, in cents
export function realizedCents(side: Side, entryPoints: number, exitPoints: number, ctx: PairContext, units: number): bigint {
  const { netUsd } = tradeMoney({ action: side, entryPoints, exitPoints }, moneySpec(ctx, units));
  return BigInt(Math.round(netUsd * 100)); // netUsd is whole cents already
}

// Cents -> an exact NUMERIC(14,2) literal ('-123.45'), never through a float
export function centsToDecimal(cents: bigint): string {
  const sign = cents < 0n ? '-' : '';
  const abs = cents < 0n ? -cents : cents;
  return `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}

// A NUMERIC(14,2) string from the DB -> cents, exactly
export function decimalToCents(value: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new Error(`not a 2-decimal amount: ${value}`);
  const cents = BigInt(match[2]) * 100n + BigInt((match[3] ?? '0').padEnd(2, '0'));
  return match[1] === '-' ? -cents : cents;
}
