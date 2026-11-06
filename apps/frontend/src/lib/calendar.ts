import type { CalendarEvent } from '../types/api.types';

// Where calendar events come from. Mirrors OFFICIAL_SOURCES in
// apps/domain-service/src/economic-calendar/official-sources.ts.
export const CALENDAR_SOURCES: Readonly<Record<string, { attribution: string; url: string }>> = {
  FOMC: {
    attribution: 'Board of Governors of the Federal Reserve System',
    url: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',
  },
  ECB: {
    attribution: 'European Central Bank',
    url: 'https://www.ecb.europa.eu/press/calendars/mgcgc/html/index.en.html',
  },
};

// The currencies the official calendars cover today.
export const CALENDAR_CURRENCIES = ['USD', 'EUR'] as const;

export const IMPACT_NOTE = 'Impact is a ForexEdge classification, not source data.';
export const COVERAGE_NOTE =
  'GBP and JPY events are not available. US data releases (BLS) are not included yet. '
  + 'Events only: the official calendars publish no forecasts, previous values or actuals.';

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
