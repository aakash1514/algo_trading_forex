// Stop-loss / take-profit levels must sit on the right side of the price a
// position would exit at: LONG exits on the bid (SL < bid < TP), SHORT exits on
// the ask (TP < ask < SL). A level on the wrong side would trigger on the very
// next tick. Shared by order placement and PATCH /positions/:id.
export interface ExitLevels {
  stopLoss: number | null;
  takeProfit: number | null;
}

export function exitLevelProblem(
  direction: 'LONG' | 'SHORT',
  quote: { bid: number; ask: number },
  { stopLoss, takeProfit }: ExitLevels,
): string | null {
  if (direction === 'LONG') {
    if (stopLoss !== null && !(stopLoss < quote.bid)) {
      return `Stop loss ${stopLoss} must be below the bid ${quote.bid} for a LONG position`;
    }
    if (takeProfit !== null && !(takeProfit > quote.bid)) {
      return `Take profit ${takeProfit} must be above the bid ${quote.bid} for a LONG position`;
    }
    return null;
  }
  if (stopLoss !== null && !(stopLoss > quote.ask)) {
    return `Stop loss ${stopLoss} must be above the ask ${quote.ask} for a SHORT position`;
  }
  if (takeProfit !== null && !(takeProfit < quote.ask)) {
    return `Take profit ${takeProfit} must be below the ask ${quote.ask} for a SHORT position`;
  }
  return null;
}
