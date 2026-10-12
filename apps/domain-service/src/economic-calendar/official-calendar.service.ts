import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';
import { InjectRedis } from '../redis/redis.decorator';
import {
  CALENDAR_USER_AGENT, CalendarParseError, OFFICIAL_SOURCES, type CalendarSource, type OfficialEvent,
} from './official-sources';
import { parseFomcCalendar } from './fomc.parser';
import { parseEcbCalendar } from './ecb.parser';

const PARSERS: Readonly<Record<CalendarSource, (html: string) => OfficialEvent[]>> = {
  FOMC: parseFomcCalendar,
  ECB: parseEcbCalendar,
};

const CLAIM_TTL_S = 48 * 60 * 60; // outlives its UTC day
const FETCH_TIMEOUT_MS = 30_000;

export type PageFetcher = (url: string, userAgent: string) => Promise<{ status: number; body: string }>;

export const fetchPage: PageFetcher = async (url, userAgent) => {
  const res = await fetch(url, { headers: { 'User-Agent': userAgent }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  return { status: res.status, body: await res.text() };
};

// The error and, for a network failure, its underlying code (Node's fetch reports only "fetch failed").
export function describeFailure(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  if (err instanceof CalendarParseError) return err.message;
  const cause = (err as { cause?: { code?: unknown; name?: unknown } }).cause;
  const code = cause && (typeof cause.code === 'string' ? cause.code : typeof cause.name === 'string' ? cause.name : null);
  return code ? `${err.message}: ${code}` : err.message;
}

export type SyncOutcome = { source: CalendarSource; outcome: 'synced'; events: number } |
  { source: CalendarSource; outcome: 'skipped' } | { source: CalendarSource; outcome: 'kept'; reason: string };

// Syncs the economic calendar from the official calendars, each fetched at most once per UTC day (a Redis
// claim per source and date, set before the request, so neither restarts nor failures fetch more often;
// the daily cron is the first attempt of each day). On a fetch or
// parse failure the source's stored events are kept and the failure is logged; nothing is invented.
// On success the source's events from today on are replaced by the page's (a cancelled meeting
// disappears), and earlier events are kept.
@Injectable()
export class OfficialCalendarService implements OnApplicationBootstrap {
  private readonly logger = new Logger(OfficialCalendarService.name);
  fetcher: PageFetcher = fetchPage;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Not awaited: a slow source must not hold up startup
    void this.syncAll().catch((err: unknown) => this.logger.error(`Calendar sync failed: ${String(err)}`));
  }

  @Cron('15 6 * * *', { timeZone: 'UTC' })
  async scheduledSync(): Promise<void> {
    await this.syncAll();
  }

  async syncAll(now = new Date()): Promise<SyncOutcome[]> {
    const outcomes: SyncOutcome[] = [];
    for (const source of Object.keys(OFFICIAL_SOURCES) as CalendarSource[]) {
      outcomes.push(await this.syncSource(source, now));
    }
    return outcomes;
  }

  async syncSource(source: CalendarSource, now = new Date()): Promise<SyncOutcome> {
    const { url } = OFFICIAL_SOURCES[source];
    // NX: only the first caller of the UTC day gets to fetch
    const day = now.toISOString().slice(0, 10);
    const claimed = await this.redis.set(`calendar:fetched:${source}:${day}`, now.toISOString(), 'EX', CLAIM_TTL_S, 'NX');
    if (claimed !== 'OK') return { source, outcome: 'skipped' };

    let events: OfficialEvent[];
    try {
      const page = await this.fetcher(url, CALENDAR_USER_AGENT);
      if (page.status !== 200) throw new Error(`HTTP ${page.status}`);
      events = PARSERS[source](page.body);
    } catch (err) {
      const reason = describeFailure(err);
      this.logger.error(`Calendar ${source}: kept the last good events (${reason})`);
      return { source, outcome: 'kept', reason };
    }

    await this.store(source, events, now);
    this.logger.log(`Calendar ${source}: ${events.length} events from ${url}`);
    return { source, outcome: 'synced', events: events.length };
  }

  private async store(source: CalendarSource, events: OfficialEvent[], now: Date): Promise<void> {
    const today = `${now.toISOString().slice(0, 10)}T00:00:00Z`;
    await this.dataSource.transaction(async (manager) => {
      await manager.query(`DELETE FROM economic_events WHERE source = $1 AND scheduled_at >= $2`, [source, today]);
      for (const e of events) {
        await manager.query(
          `INSERT INTO economic_events (title, currency, impact, scheduled_at, all_day, source)
           VALUES ($1, $2, $3, $4, true, $5)
           ON CONFLICT (source, scheduled_at, title) WHERE source IS NOT NULL DO NOTHING`,
          [e.title, e.currency, e.impact, `${e.date}T00:00:00Z`, e.source],
        );
      }
    });
  }
}
