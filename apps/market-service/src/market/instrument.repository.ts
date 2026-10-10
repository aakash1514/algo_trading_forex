import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { InstrumentKind } from '@forexedge/common';

@Injectable()
export class InstrumentRepository {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  // Returns instrument names in OANDA format (EUR_USD) for active pairs
  // StreamService calls this on startup to know which pairs to subscribe to
  async findActiveInstruments(): Promise<string[]> {
    const result = await this.dataSource.query<{ pair: string }[]>(
      `SELECT pair FROM instruments WHERE is_active = true ORDER BY pair`,
    );

    // Convert DB format EUR/USD → OANDA format EUR_USD
    return result.map((r) => r.pair.replace('/', '_'));
  }

  // Quote specs for active instruments, keyed by OANDA format (EUR_USD):
  // pip_size (price precision) and avg_spread (typical ask - bid, price units).
  async findQuoteSpecs(): Promise<Map<string, InstrumentQuoteSpec>> {
    const rows = await this.dataSource.query<{ pair: string; pip_size: string; avg_spread: string | null; type: string }[]>(
      `SELECT pair, pip_size, avg_spread, type FROM instruments WHERE is_active = true`,
    );
    return new Map(rows.map((r) => [
      r.pair.replace('/', '_'),
      {
        pipSize: Number(r.pip_size),
        avgSpread: r.avg_spread === null ? null : Number(r.avg_spread),
        kind: r.type as InstrumentKind,
      },
    ]));
  }
}

export interface InstrumentQuoteSpec {
  pipSize: number;
  avgSpread: number | null;
  kind: InstrumentKind; // instruments.type: METAL keeps its own market hours
}