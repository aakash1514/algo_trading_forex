import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';
import { InjectRedis } from '../redis/redis.decorator';
import { CALENDAR_USER_AGENT, CalendarParseError, OFFICIAL_SOURCES, type OfficialEvent } from './official-sources';
import { parseFomcCalendar } from './fomc.parser';
import { parseEcbCalendar } from './ecb.parser';
import { FOREXFACTORY } from './forexfactory/forexfactory.source';
import { parseForexFactoryWeek } from './forexfactory/forexfactory.parser';

export type SyncSource = 'FOMC' | 'ECB' | 'FOREXFACTORY';

// What a successful fetch replaces: the source's stored events in [from, to] (to null = no upper bound)
interface ParsedPage {
  events: OfficialEvent[];
  replace: { from: string; to: string | null };
  detail?: string;
  midnightTitles?: string[];
}

interface SourceAdapter {
  url: string;
  // fetches per UTC day: 1 = one claim per date; 2 = one per half day (00-12 and 12-24 UTC)
  fetchesPerDay: 1 | 2;
  parse(body: string, contentType: string | null, now: Date): ParsedPage;
}

const startOfUtcDay = (now: Date) => `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;

// FOMC/ECB: the page lists the whole schedule, so events from today on are replaced (a cancelled meeting
// disappears) and earlier ones kept. Forex Factory: the export is one week, so exactly that week is replaced.
const SOURCES: Readonly<Record<SyncSource, SourceAdapter>> = {
  FOMC: {
    url: OFFICIAL_SOURCES.FOMC.url,
    fetchesPerDay: 1,
    parse: (body, _type, now) => ({ events: parseFomcCalendar(body), replace: { from: startOfUtcDay(now), to: null } }),
  },
  ECB: {
    url: OFFICIAL_SOURCES.ECB.url,
    fetchesPerDay: 1,
    parse: (body, _type, now) => ({ events: parseEcbCalendar(body), replace: { from: startOfUtcDay(now), to: null } }),
  },
  FOREXFACTORY: {
    url: FOREXFACTORY.url,
    fetchesPerDay: 2,
    parse: (body, contentType) => {
      const week = parseForexFactoryWeek(body, contentType);
      const s = week.skipped;
      return {
        events: week.events,
        replace: week.range,
        detail: `week ${week.range.from} to ${week.range.to}; skipped holiday ${s.holiday}, non-economic ${s.nonEconomic}, `
          + `midnight (possibly All Day/Tentative) ${s.midnight}, duplicate of FOMC/ECB ${s.duplicate}`,
        midnightTitles: week.midnightTitles,
      };
    },
  },
};

const CLAIM_TTL_S = 48 * 60 * 60; // outlives its UTC day
const FETCH_TIMEOUT_MS = 30_000;

export type FetchedPage = { status: number; contentType: string | null; body: string };
export type PageFetcher = (url: string, userAgent: string) => Promise<FetchedPage>;

// One plain request with the ForexEdge User-Agent: no other headers, no retry.
export const fetchPage: PageFetcher = async (url, userAgent) => {
  const res = await fetch(url, { headers: { 'User-Agent': userAgent }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  return { status: res.status, contentType: res.headers.get('content-type'), body: await res.text() };
};

// The error and, for a network failure, its underlying code (Node's fetch reports only "fetch failed").
export function describeFailure(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  if (err instanceof CalendarParseError) return err.message;
  const cause = (err as { cause?: { code?: unknown; name?: unknown } }).cause;
  const code = cause && (typeof cause.code === 'string' ? cause.code : typeof cause.name === 'string' ? cause.name : null);
  return code ? `${err.message}: ${code}` : err.message;
}

// The Redis claim key of the current fetch slot: one per UTC date, or per half day for a twice-daily source
export function claimKey(source: SyncSource, now: Date): string {
  const day = now.toISOString().slice(0, 10);
  if (SOURCES[source].fetchesPerDay === 1) return `calendar:fetched:${source}:${day}`;
  return `calendar:fetched:${source}:${day}:${now.getUTCHours() < 12 ? 'am' : 'pm'}`;
}

export type SyncOutcome = { source: SyncSource; outcome: 'synced'; events: number } |
  { source: SyncSource; outcome: 'skipped' } | { source: SyncSource; outcome: 'kept'; reason: string };

// Syncs the economic calendar: FOMC and ECB from their official calendars (at most once per UTC day) and the
// Forex Factory weekly export (at most twice per UTC day). A Redis claim per source and fetch slot is set
// before the request, so neither restarts nor failures fetch more often; the crons (06:15 all sources, 18:15
// Forex Factory) are each slot's first attempt. On a fetch or parse failure (any non-200, a non-JSON answer
// or a challenge page for Forex Factory, unexpected markup) the source's stored events are kept and one line
// is logged; there is no retry, and nothing is invented. On success the source's events in the page's range
// are replaced in one transaction.
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

  @Cron('15 18 * * *', { timeZone: 'UTC' })
  async scheduledEveningSync(): Promise<void> {
    await this.syncSource('FOREXFACTORY');
  }

  async syncAll(now = new Date()): Promise<SyncOutcome[]> {
    const outcomes: SyncOutcome[] = [];
    for (const source of Object.keys(SOURCES) as SyncSource[]) {
      outcomes.push(await this.syncSource(source, now));
    }
    return outcomes;
  }

  async syncSource(source: SyncSource, now = new Date()): Promise<SyncOutcome> {
    const adapter = SOURCES[source];
    // NX: only the first caller of the fetch slot gets to fetch
    const claimed = await this.redis.set(claimKey(source, now), now.toISOString(), 'EX', CLAIM_TTL_S, 'NX');
    if (claimed !== 'OK') return { source, outcome: 'skipped' };

    let page: ParsedPage;
    try {
      const res = await this.fetcher(adapter.url, CALENDAR_USER_AGENT);
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      page = adapter.parse(res.body, res.contentType, now);
      await this.store(source, page);
    } catch (err) {
      const reason = describeFailure(err);
      this.logger.error(`Calendar ${source}: kept the last good events (${reason})`);
      return { source, outcome: 'kept', reason };
    }

    this.logger.log(`Calendar ${source}: ${page.events.length} events from ${adapter.url}${page.detail ? `; ${page.detail}` : ''}`);
    if (page.midnightTitles?.length) {
      this.logger.warn(`Calendar ${source}: skipped at local midnight: ${page.midnightTitles.join('; ')}`);
    }
    return { source, outcome: 'synced', events: page.events.length };
  }

  private async store(source: SyncSource, page: ParsedPage): Promise<void> {
    const { from, to } = page.replace;
    await this.dataSource.transaction(async (manager) => {
      if (to === null) {
        await manager.query(`DELETE FROM economic_events WHERE source = $1 AND scheduled_at >= $2`, [source, from]);
      } else {
        await manager.query(
          `DELETE FROM economic_events WHERE source = $1 AND scheduled_at BETWEEN $2 AND $3`, [source, from, to]);
      }
      for (const e of page.events) {
        await manager.query(
          `INSERT INTO economic_events (title, currency, impact, scheduled_at, time_source, source)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (source, scheduled_at, currency, title) DO NOTHING`,
          [e.title, e.currency, e.impact, e.scheduledAt, e.timeSource, e.source],
        );
      }
    });
  }
}
