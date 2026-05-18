import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

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
}