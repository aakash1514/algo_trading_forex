import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { marketStatus, type InstrumentKind, type MarketStatus } from '@forexedge/common';

// Whether order-service enforces market hours (FX weekends, gold's daily
// 17:00-18:00 New York break). Controls the market-closed order gate, the
// manual-close block, and skipping P&L and stop-loss/take-profit on ticks
// stamped while the instrument's market is closed.
//
// MARKET_HOURS_GATE: unset or "true" = enforced (the default and the only
// production setting); "false" = disabled, for development on weekends only
// (pair it with MOCK_STREAM_WHEN_CLOSED=true on market-service). Any other value
// fails startup rather than silently picking a side.
export function parseMarketHoursGate(raw: string | undefined): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '' || value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`MARKET_HOURS_GATE must be "true" or "false", got "${raw}"`);
}

@Injectable()
export class MarketHoursPolicy {
  private readonly logger = new Logger(MarketHoursPolicy.name);
  readonly enforced: boolean;

  constructor(config: ConfigService) {
    this.enforced = parseMarketHoursGate(config.get<string>('MARKET_HOURS_GATE'));
    if (!this.enforced) {
      this.logger.warn('MARKET_HOURS_GATE=false: market hours are NOT enforced (development only)');
    }
  }

  status(kind: InstrumentKind, at: Date = new Date()): MarketStatus {
    return this.enforced ? marketStatus(kind, at) : { open: true };
  }
}

// "Market closed for XAU/USD: daily break 17:00-18:00 New York (reopens 2026-10-12 22:00 UTC)"
export function marketClosedReason(pair: string, status: MarketStatus): string {
  const why = status.reason === 'DAILY_BREAK' ? 'daily break 17:00-18:00 New York' : 'weekend';
  const reopens = status.reopensAt ? ` (reopens ${status.reopensAt.toISOString().slice(0, 16).replace('T', ' ')} UTC)` : '';
  return `Market closed for ${pair}: ${why}${reopens}`;
}
