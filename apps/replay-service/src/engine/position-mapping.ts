import { ReplayPositionEntity } from '@forexedge/database';
import { centsToDecimal, decimalToCents } from './booking';
import { EnginePosition } from './replay-engine';

export function toEngine(p: ReplayPositionEntity): EnginePosition {
  return {
    id: p.id, side: p.side, units: p.units, status: p.status,
    stopLossPoints: p.stopLossPoints, takeProfitPoints: p.takeProfitPoints,
    entryTime: p.entryTime, entryPoints: p.entryPoints, exitRequestedAt: p.exitRequestedAt,
    exitTime: p.exitTime, exitPoints: p.exitPoints, exitReason: p.exitReason,
    realizedCents: p.realizedPnlUsd === null ? null : decimalToCents(p.realizedPnlUsd),
  };
}

// Copies what the engine changes (fill, close) back onto the entity
export function applyEngine(entity: ReplayPositionEntity, p: EnginePosition): ReplayPositionEntity {
  return Object.assign(entity, {
    status: p.status, entryTime: p.entryTime, entryPoints: p.entryPoints, exitTime: p.exitTime,
    exitPoints: p.exitPoints, exitReason: p.exitReason,
    realizedPnlUsd: p.realizedCents === null ? null : centsToDecimal(p.realizedCents),
  });
}
