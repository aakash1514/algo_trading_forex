import { ReplayPositionEntity } from '@forexedge/database';

// Integer points -> an exact decimal string at the pair's scale (113030, 5 -> '1.13030')
export function pointsToDecimal(points: number, priceDecimals: number): string {
  const sign = points < 0 ? '-' : '';
  const digits = String(Math.abs(points)).padStart(priceDecimals + 1, '0');
  return priceDecimals === 0 ? `${sign}${digits}`
    : `${sign}${digits.slice(0, -priceDecimals)}.${digits.slice(-priceDecimals)}`;
}

export interface PositionView {
  id: string;
  side: 'BUY' | 'SELL';
  lots: string;
  units: number;
  status: string;
  placedAt: string;
  stopLoss: string | null;
  takeProfit: string | null;
  marginUsd: string;
  entryTime: string | null;
  entryPrice: string | null;
  exitRequestedAt: string | null;
  exitTime: string | null;
  exitPrice: string | null;
  exitReason: string | null;
  realizedPnlUsd: string | null;
  cancelledAt: string | null;
}

export function positionView(p: ReplayPositionEntity, priceDecimals: number): PositionView {
  const price = (points: number | null) => (points === null ? null : pointsToDecimal(points, priceDecimals));
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  return {
    id: p.id,
    side: p.side,
    lots: p.lots,
    units: p.units,
    status: p.status,
    placedAt: p.placedAt.toISOString(),
    stopLoss: price(p.stopLossPoints),
    takeProfit: price(p.takeProfitPoints),
    marginUsd: p.marginUsd,
    entryTime: iso(p.entryTime),
    entryPrice: price(p.entryPoints),
    exitRequestedAt: iso(p.exitRequestedAt),
    exitTime: iso(p.exitTime),
    exitPrice: price(p.exitPoints),
    exitReason: p.exitReason,
    realizedPnlUsd: p.realizedPnlUsd,
    cancelledAt: iso(p.cancelledAt),
  };
}
