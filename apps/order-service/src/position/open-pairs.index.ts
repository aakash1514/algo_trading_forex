import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PositionEntity } from '@forexedge/database';

// Which pairs (EUR/USD format) currently have open positions, with counts.
// The tick consumer skips every other pair without touching the DB: of ~29
// streamed instruments, usually only a couple have open positions, and a DB
// round trip per tick for the rest made the consumer fall behind the feed.
//
// Kept current in the same code paths that open (OrderService fill) and close
// (PositionService.closePosition) positions, right after their transactions
// commit. A full re-sync from the DB at startup and every 30 s corrects any
// drift (e.g. a position changed by another process or a crash between
// commit and update).
//
// Provided once, by KafkaConsumerModule (see CLAUDE.md: duplicate instances
// would have separate state).
@Injectable()
export class OpenPairsIndex implements OnModuleInit, OnModuleDestroy {
  static readonly RESYNC_INTERVAL_MS = 30_000;

  private readonly logger = new Logger(OpenPairsIndex.name);
  private counts = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(PositionEntity)
    private readonly positionRepo: Repository<PositionEntity>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.resync();
    this.timer = setInterval(() => {
      this.resync().catch((err: Error) => this.logger.error(`Open-pairs re-sync failed: ${err.message}`));
    }, OpenPairsIndex.RESYNC_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  has(pair: string): boolean {
    return (this.counts.get(pair) ?? 0) > 0;
  }

  pairs(): string[] {
    return [...this.counts.keys()];
  }

  // A position on `pair` was opened (called after the fill transaction committed).
  opened(pair: string): void {
    this.counts.set(pair, (this.counts.get(pair) ?? 0) + 1);
  }

  // A position on `pair` was closed (called after the close transaction committed).
  closed(pair: string): void {
    const next = (this.counts.get(pair) ?? 0) - 1;
    if (next > 0) this.counts.set(pair, next);
    else this.counts.delete(pair);
  }

  async resync(): Promise<void> {
    const rows = await this.positionRepo
      .createQueryBuilder('p')
      .select('p.pair', 'pair')
      .addSelect('COUNT(*)', 'open')
      .where('p.is_open = true')
      .groupBy('p.pair')
      .getRawMany<{ pair: string; open: string }>();
    const fresh = new Map(rows.map((r) => [r.pair, Number(r.open)]));
    if (!sameCounts(this.counts, fresh)) {
      this.logger.debug(`Open pairs re-synced: ${JSON.stringify(Object.fromEntries(fresh))}`);
    }
    this.counts = fresh;
  }
}

function sameCounts(a: Map<string, number>, b: Map<string, number>): boolean {
  return a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);
}
