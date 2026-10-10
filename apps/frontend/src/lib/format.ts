// Signed USD amount for P&L: +$38.46 / -$20.99 / +$0.00. The sign goes before the
// currency symbol in both directions (toFixed alone would render "$-20.99").
export function formatSignedUsd(value: number): string {
  const rounded = Number(value.toFixed(2));
  const sign = rounded < 0 ? '-' : '+';
  return `${sign}$${Math.abs(rounded).toFixed(2)}`;
}
