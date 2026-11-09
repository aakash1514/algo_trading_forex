import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { loadPairContext, PairContext } from './replay-history';

// Contract specs and history bounds per pair; they don't change while the service
// runs (the importer is offline tooling), so each pair is read once.
@Injectable()
export class PairContextService {
  private readonly cache = new Map<string, Promise<PairContext>>();

  constructor(private readonly dataSource: DataSource) {}

  get(pair: string): Promise<PairContext> {
    let ctx = this.cache.get(pair);
    if (!ctx) {
      ctx = loadPairContext(this.dataSource, pair);
      ctx.catch(() => this.cache.delete(pair)); // retry a failed read next time
      this.cache.set(pair, ctx);
    }
    return ctx;
  }
}
