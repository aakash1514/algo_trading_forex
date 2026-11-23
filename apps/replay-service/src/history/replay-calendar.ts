// Economic calendar events for the replay chart, never ahead of the replay clock.
//
// Only events whose scheduled time is at or before the clock are ever read: the query
// itself bounds scheduled_at by the clock (an event in the current bar but after the
// clock is not sent until a step reaches it), and the emitter checks every payload's
// `time` against the clock again. HIGH and MEDIUM impact only; the page toggles MEDIUM.
// economic_events holds what domain-service synced from the official FOMC and ECB
// calendars and the third-party export; nothing here adds or estimates an event.
import type { DataSource } from 'typeorm';
import { HistoricalTimeframe, historicalBucketSql } from '@forexedge/database';

export const CALENDAR_IMPACTS = ['HIGH', 'MEDIUM'] as const;

// Metals are quoted against USD but have no calendar of their own
const NON_CURRENCIES = new Set(['XAU', 'XAG']);

// The calendar currencies of a pair: its legs, metals dropped (XAU/USD -> USD)
export function calendarCurrencies(pair: string): string[] {
  return pair.split('/').filter((leg) => leg.length === 3 && !NON_CURRENCIES.has(leg));
}

export interface CalendarEventView {
  id: string;
  time: string;              // scheduled_at, ISO UTC (a market time: checked against the clock)
  barTime: string;           // start of the session-timeframe bar holding `time`
  title: string;             // the source's wording
  currency: string;
  impact: 'HIGH' | 'MEDIUM';
  source: string;
  timeSource: 'official' | 'expected' | 'third_party';
  actual: string | null;
  forecast: string | null;
  previous: string | null;
}

export interface CalendarView {
  // Some event for the pair's currencies exists at or before the clock; false means the
  // calendar has no data for this period (the page says so). Nothing about later events.
  covered: boolean;
  events: CalendarEventView[];  // oldest first
}

interface Window {
  after: Date | null;   // exclusive; null = from `from`
  from: Date | null;    // inclusive (the first bar shown); ignored when `after` is set
  upTo: Date;           // inclusive: the clock
}

// The events of `currencies` in the window, each with the bar that holds it
export async function calendarEvents(
  ds: DataSource, currencies: string[], timeframe: HistoricalTimeframe, window: Window,
): Promise<CalendarEventView[]> {
  if (currencies.length === 0) return [];
  const bucket = historicalBucketSql(timeframe, `date_trunc('minute', e.scheduled_at)`);
  const lower = window.after ? `AND e.scheduled_at > $4` : window.from ? `AND e.scheduled_at >= $4` : '';
  const params: unknown[] = [currencies, [...CALENDAR_IMPACTS], window.upTo];
  if (lower) params.push(window.after ?? window.from);
  const rows: Record<string, unknown>[] = await ds.query(
    `SELECT e.id, e.scheduled_at, ${bucket} AS bar_time, e.title, e.currency, e.impact, e.source, e.time_source,
            e.actual, e.forecast, e.previous
       FROM economic_events e
      WHERE e.currency = ANY($1::text[]) AND e.impact = ANY($2::text[])
        AND e.scheduled_at <= $3 ${lower}
      ORDER BY e.scheduled_at, e.id`, params);
  return rows.map((r) => ({
    id: r['id'] as string,
    time: new Date(r['scheduled_at'] as string).toISOString(),
    barTime: new Date(r['bar_time'] as string).toISOString(),
    title: r['title'] as string,
    currency: (r['currency'] as string).trim(),
    impact: r['impact'] as CalendarEventView['impact'],
    source: r['source'] as string,
    timeSource: r['time_source'] as CalendarEventView['timeSource'],
    actual: (r['actual'] as string | null) ?? null,
    forecast: (r['forecast'] as string | null) ?? null,
    previous: (r['previous'] as string | null) ?? null,
  }));
}

export async function calendarCovered(ds: DataSource, currencies: string[], clock: Date): Promise<boolean> {
  if (currencies.length === 0) return false;
  const [row] = await ds.query(
    `SELECT EXISTS (SELECT 1 FROM economic_events
                     WHERE currency = ANY($1::text[]) AND impact = ANY($2::text[]) AND scheduled_at <= $3) AS covered`,
    [currencies, [...CALENDAR_IMPACTS], clock]);
  return row.covered === true;
}

// The calendar of a state: events from the first bar shown up to the clock
export async function calendarView(
  ds: DataSource, pair: string, timeframe: HistoricalTimeframe, firstBar: Date, clock: Date,
): Promise<CalendarView> {
  const currencies = calendarCurrencies(pair);
  return {
    covered: await calendarCovered(ds, currencies, clock),
    events: await calendarEvents(ds, currencies, timeframe, { after: null, from: firstBar, upTo: clock }),
  };
}
