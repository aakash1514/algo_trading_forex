import type { CalendarEvent } from '../types/api.types';

// Where calendar events come from. Mirrors OFFICIAL_SOURCES in
// apps/domain-service/src/economic-calendar/official-sources.ts and the Forex Factory export
// (economic-calendar/forexfactory/), a third-party source approved for portfolio use only.
export const CALENDAR_SOURCES: Readonly<Record<string, { attribution: string; url: string }>> = {
  FOMC: {
    attribution: 'Board of Governors of the Federal Reserve System',
    url: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',
  },
  ECB: {
    attribution: 'European Central Bank',
    url: 'https://www.ecb.europa.eu/press/calendars/mgcgc/html/index.en.html',
  },
  FOREXFACTORY: {
    attribution: 'Forex Factory',
    url: 'https://www.forexfactory.com/calendar',
  },
};

// The third-party source: its rows say "via ForexFactory" and its impact is ForexFactory's own level.
export const THIRD_PARTY_SOURCE = 'FOREXFACTORY';
export const THIRD_PARTY_LABEL = 'via ForexFactory';
export const THIRD_PARTY_IMPACT_LABEL = 'ForexFactory impact';

// The currencies the calendar covers (the Forex Factory export's currencies include the official ones).
export const CALENDAR_CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'NZD', 'CNY'] as const;

export const IMPACT_NOTE =
  'Impact is a ForexEdge classification for FOMC and ECB events and ForexFactory’s own level for the others.';
export const COVERAGE_NOTE =
  'FOMC and ECB from official sources; all other events via Forex Factory. Direct BLS access is blocked '
  + '(HTTP 403, 2026-11-06). Events only: no forecasts, previous values or actuals.';

export const EXPECTED_TIME_NOTE = 'Fed publishes no standard release time; based on recent statements.';

// Every event shows in UTC, labelled, so the time is the same for every viewer. An 'expected' time (FOMC)
// says so.
export function eventWhen(event: Pick<CalendarEvent, 'scheduledAt' | 'timeSource'>): { date: string; time: string } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23', timeZone: 'UTC',
  }).formatToParts(new Date(event.scheduledAt)).map((p) => [p.type, p.value]));
  return {
    date: `${parts.weekday} ${parts.day} ${parts.month} ${parts.year}`,
    time: `${parts.hour}:${parts.minute} UTC${event.timeSource === 'expected' ? ' (expected)' : ''}`,
  };
}
