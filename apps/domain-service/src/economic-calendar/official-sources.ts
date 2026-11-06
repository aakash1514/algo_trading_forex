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
// - U.S. Bureau of Labor Statistics: public domain (https://www.bls.gov/opub/copyright-information.htm,
//   citing BLS as the source). robots.txt (checked 2026-11-06) disallows nothing under /schedule/news_release/
//   for other robots and sets no crawl delay. BLS may block robots without the owner's contact information, so
//   its User-Agent carries CALENDAR_CONTACT_EMAIL (from .env; BLS is disabled without it). Two release
//   schedules only: the Consumer Price Index and the Employment Situation.
// Each page is fetched at most once a day with a User-Agent that identifies ForexEdge.

export type CalendarSource = 'FOMC' | 'ECB' | 'BLS_CPI' | 'BLS_EMPSIT';

// Where an event's time comes from: 'official' when the source publishes it (a time per row, or a documented
// standard time for every event of that kind); 'expected' when the source publishes none and the time is the
// one its recent releases used (FOMC_EXPECTED_TIME).
export type TimeSource = 'official' | 'expected';

export interface OfficialSource {
  source: CalendarSource;
  url: string;
  attribution: string;
  // the source's User-Agent carries the owner's contact email (BLS only)
  needsContact: boolean;
}

const REPO_URL = 'https://github.com/aakash1514/algo_trading_forex';
export const CALENDAR_USER_AGENT = `ForexEdge (+${REPO_URL})`;

// The User-Agent for a source. Only a source that needs it (BLS) gets the contact email, and only the value
// from CALENDAR_CONTACT_EMAIL; every other source gets CALENDAR_USER_AGENT.
export function calendarUserAgent(source: OfficialSource, contactEmail: string): string {
  return source.needsContact ? `ForexEdge (+${REPO_URL}; ${contactEmail})` : CALENDAR_USER_AGENT;
}

// CALENDAR_CONTACT_EMAIL as configured: one plausible address, or null (unset, empty or malformed: BLS
// stays disabled). Never logged.
export function parseContactEmail(raw: string | undefined): string | null {
  const value = raw?.trim() ?? '';
  return /^[^\s@;()<>,"]+@[^\s@;()<>,"]+\.[A-Za-z]{2,}$/.test(value) ? value : null;
}

export const OFFICIAL_SOURCES: Readonly<Record<CalendarSource, OfficialSource>> = {
  FOMC: {
    source: 'FOMC',
    url: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',
    attribution: 'Board of Governors of the Federal Reserve System',
    needsContact: false,
  },
  ECB: {
    source: 'ECB',
    url: 'https://www.ecb.europa.eu/press/calendars/mgcgc/html/index.en.html',
    attribution: 'European Central Bank',
    needsContact: false,
  },
  BLS_CPI: {
    source: 'BLS_CPI',
    url: 'https://www.bls.gov/schedule/news_release/cpi.htm',
    attribution: 'U.S. Bureau of Labor Statistics',
    needsContact: true,
  },
  BLS_EMPSIT: {
    source: 'BLS_EMPSIT',
    url: 'https://www.bls.gov/schedule/news_release/empsit.htm',
    attribution: 'U.S. Bureau of Labor Statistics',
    needsContact: true,
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

// BLS: each schedule row gives its own release time ("08:30 AM"). The schedule pages don't name the zone; the
// BLS release calendar does: "NOTE: All times on calendar are Eastern Time."
// (https://www.bls.gov/schedule/news_release/, checked 2026-11-06), so the zone is America/New_York.
export const BLS_TIME_ZONE = 'America/New_York';
export const BLS_TIME_ZONE_BASIS = 'https://www.bls.gov/schedule/news_release/';

export type Impact = 'HIGH' | 'MEDIUM' | 'LOW';

// One event as the source publishes it, at its release moment in UTC.
export interface OfficialEvent {
  source: CalendarSource;
  title: string;          // the source's own wording
  currency: 'USD' | 'EUR';
  scheduledAt: string;    // ISO 8601, UTC
  timeSource: TimeSource;
  impact: Impact;         // ForexEdge classification (impact.ts), not source data
}

export class CalendarParseError extends Error {}
