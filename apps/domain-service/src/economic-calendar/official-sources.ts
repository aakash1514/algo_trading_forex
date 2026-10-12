// Official central-bank calendars the economic calendar is built from. Events only: these pages publish
// dates, not consensus forecasts, previous values or actuals (those stay null and show as "—").
//
// Terms (checked 2026-10-12):
// - Federal Reserve Board: "Unless otherwise indicated, information on Board's website is in the public
//   domain and may be copied and distributed without permission. Please cite to the Board as the source of
//   the information." (https://www.federalreserve.gov/disclaimer.htm). robots.txt: none (404, so no rules).
// - ECB: free use of information obtained directly from its website, citing the ECB as the source and
//   stating any modification (https://www.ecb.europa.eu/services/disclaimer/html/index.en.html).
//   robots.txt does not disallow /press/calendars/ and asks for a 5 s crawl delay.
// Each page is fetched at most once a day with a User-Agent that identifies ForexEdge.
// The BLS release calendar (US data releases) is not included: bls.gov refuses automated requests that
// don't follow its usage policy (docs/OVERNIGHT-QUESTIONS.md #5).

export type CalendarSource = 'FOMC' | 'ECB';

export interface OfficialSource {
  source: CalendarSource;
  url: string;
  attribution: string;
}

export const CALENDAR_USER_AGENT =
  'ForexEdge/0.1 (economic calendar; +https://github.com/aakash1514/algo_trading_forex)';

export const OFFICIAL_SOURCES: Readonly<Record<CalendarSource, OfficialSource>> = {
  FOMC: {
    source: 'FOMC',
    url: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',
    attribution: 'Board of Governors of the Federal Reserve System',
  },
  ECB: {
    source: 'ECB',
    url: 'https://www.ecb.europa.eu/press/calendars/mgcgc/html/index.en.html',
    attribution: 'European Central Bank',
  },
};

export type Impact = 'HIGH' | 'MEDIUM' | 'LOW';

// One event as the source publishes it. Both sources give a date without a time, so every event is
// all-day (stored at 00:00 UTC of its date with all_day = true); no time is invented.
export interface OfficialEvent {
  source: CalendarSource;
  title: string;      // the source's own wording
  currency: 'USD' | 'EUR';
  date: string;       // YYYY-MM-DD
  impact: Impact;     // ForexEdge classification (impact.ts), not source data
}

export class CalendarParseError extends Error {}
