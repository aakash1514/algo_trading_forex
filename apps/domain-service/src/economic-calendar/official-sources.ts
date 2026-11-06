// Official calendars the economic calendar is built from. Events only: these pages publish dates and
// times, not consensus forecasts, previous values or actuals (those stay null and show as "—").
//
// Terms (checked 2026-10-12):
// - Federal Reserve Board: "Unless otherwise indicated, information on Board's website is in the public
//   domain and may be copied and distributed without permission. Please cite to the Board as the source of
//   the information." (https://www.federalreserve.gov/disclaimer.htm). robots.txt: none (404, so no rules).
// - ECB: free use of information obtained directly from its website, citing the ECB as the source and
//   stating any modification (https://www.ecb.europa.eu/services/disclaimer/html/index.en.html).
//   robots.txt does not disallow /press/calendars/ and asks for a 5 s crawl delay.
// Each page is fetched at most once a day with a User-Agent that identifies ForexEdge.
//
// Coverage: FOMC and ECB from official sources; all other events via Forex Factory. Direct BLS access is
// blocked (HTTP 403, 2026-11-06). The Forex Factory export (forexfactory/) is a third-party source, approved by
// the owner for portfolio use only.

export type CalendarSource = 'FOMC' | 'ECB';

// Where an event's time comes from: 'official' when the source publishes it (a time per row, or a documented
// standard time for every event of that kind); 'expected' when the source publishes none and the time is the
// one its recent releases used (FOMC_EXPECTED_TIME); 'third_party' when a third party publishes it with the
// event (the Forex Factory export, which gives each time with its UTC offset).
export type TimeSource = 'official' | 'expected' | 'third_party';

export interface OfficialSource {
  source: CalendarSource;
  url: string;
  attribution: string;
}

export const CALENDAR_USER_AGENT = 'ForexEdge (+https://github.com/aakash1514/algo_trading_forex)';

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

// A local release time in an IANA zone (converted to UTC per date, DST included, by zoned-time.ts)
export interface ReleaseTime {
  time: string;   // HH:mm, local
  zone: string;   // IANA zone
  timeSource: TimeSource;
  basis: string;  // where the time comes from
}

// FOMC: the meeting calendar lists dates only, and the Fed publishes no standing release time for the
// statement. The EXPECTED time is the one the 8 most recent scheduled meetings' statements carried: each
// press release says "For release at 2:00 p.m." Eastern (recorded in
// __fixtures__/fomc-statements/, checked by fomc-statement-evidence.spec.ts). Shown as "(expected)".
export const FOMC_EXPECTED_TIME: ReleaseTime = {
  time: '14:00',
  zone: 'America/New_York',
  timeSource: 'expected',
  basis: 'Expected: the Fed publishes no standard release time; the last 8 scheduled FOMC statements were '
    + 'released at 2:00 p.m. Eastern (__fixtures__/fomc-statements/)',
};

// ECB: "The monetary policy decisions [...] are published in a press release at 14:15 CET on the day of the
// Governing Council monetary policy meeting." (https://www.ecb.europa.eu/press/govcdec/mopo/html/index.en.html,
// checked 2026-11-06). The ECB writes CET all year for Frankfurt local time, so the zone is Europe/Berlin
// (CEST in summer).
export const ECB_DECISION_TIME: ReleaseTime = {
  time: '14:15',
  zone: 'Europe/Berlin',
  timeSource: 'official',
  basis: 'https://www.ecb.europa.eu/press/govcdec/mopo/html/index.en.html',
};

export type Impact = 'HIGH' | 'MEDIUM' | 'LOW';

// One event as the source publishes it, at its release moment in UTC.
export interface OfficialEvent {
  source: CalendarSource | 'FOREXFACTORY';
  title: string;          // the source's own wording
  currency: string;       // ISO 4217 code
  scheduledAt: string;    // ISO 8601, UTC
  timeSource: TimeSource;
  impact: Impact;         // FOMC/ECB: ForexEdge classification (impact.ts); Forex Factory: its own level
}

export class CalendarParseError extends Error {}
