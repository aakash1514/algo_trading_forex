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

// An all-day event is stored at 00:00 UTC of its date, so its date is read in UTC (in a local time zone
// west of UTC it would show as the day before). A timed event shows in local time.
export function eventWhen(event: Pick<CalendarEvent, 'scheduledAt' | 'allDay'>): { date: string; time: string } {
  const at = new Date(event.scheduledAt);
  if (event.allDay) {
    return {
      date: at.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }),
      time: 'All day',
    };
  }
  return {
    date: at.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }),
    time: at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  };
}
