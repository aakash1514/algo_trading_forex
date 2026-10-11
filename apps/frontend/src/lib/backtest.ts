// Display helpers for backtest runs. The API returns NUMERIC columns as decimal
// strings and null where a metric is undefined (no trades, no loss, too few days);
// null is shown as an em dash, never as 0.

const toCents = (usd: string) => Math.round(Number.parseFloat(usd) * 100);

// Final equity is derived on read (initial capital + net USD), never stored
export function finalEquityUsd(initialCapital: string, totalPnlUsd: string): number {
  return (toCents(initialCapital) + toCents(totalPnlUsd)) / 100;
}

// Net USD as a % of the initial capital
export function returnPct(initialCapital: string, totalPnlUsd: string): number {
  return (toCents(totalPnlUsd) / toCents(initialCapital)) * 100;
}

// $10,000.00
export function formatUsd(value: number): string {
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// +272.2 pips / -272.2 pips
export function formatPips(value: string | null): string {
  if (value === null) return '—';
  const pips = Number.parseFloat(value);
  return `${pips > 0 ? '+' : ''}${pips.toFixed(1)} pips`;
}

export function formatMetric(value: string | null, digits: number, suffix = ''): string {
  return value === null ? '—' : `${Number.parseFloat(value).toFixed(digits)}${suffix}`;
}

// The To day is inclusive: "Includes all of 30 Dec 2022 (UTC)"
export function inclusiveToHint(toDay: string): string {
  const date = new Date(`${toDay}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(toDay) || Number.isNaN(date.getTime())) return '';
  const label = date.toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });
  return `Includes all of ${label} (UTC)`;
}

export const SHARPE_DEFINITION =
  'Daily returns of the marked-to-market USD equity at each Mon-Fri New York 17:00 close, mean / sample stdev x √260, risk-free 0';
