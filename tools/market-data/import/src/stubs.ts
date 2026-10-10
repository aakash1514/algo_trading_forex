// D1 stubs: New York day bars with fewer than 60 traded minutes. Every stub in
// the 2010-2022 Dukascopy export is named below and was checked minute by minute
// against the source files; the check fails on any stub not in this list, and on
// any listed stub missing from an imported period.
//
// Two kinds are allowed:
//   sunday   the bar starting Saturday 17:00 NY, holding a traded minute at
//            Sunday 16:59 NY (FX, 2013-2015), one minute before the week opens
//   holiday  a short session on a listed holiday trading day: Dec 24-26,
//            Dec 31-Jan 2, Good Friday, Easter Monday
//
// A bar is named by the NY date and time it starts (D1 bars start at 17:00 NY
// the day before the session they hold).

export type StubKind = 'sunday' | 'holiday';

export interface Stub {
  pair: string;
  nyStart: string; // 'YYYY-MM-DD HH:MI', America/New_York
  minutes: number;
}

export interface ExpectedStub extends Stub {
  kind: StubKind;
}

const sunday = (pair: string, saturday: string): ExpectedStub =>
  ({ pair, nyStart: `${saturday} 17:00`, minutes: 1, kind: 'sunday' });
const holiday = (pair: string, nyStart: string, minutes: number): ExpectedStub =>
  ({ pair, nyStart, minutes, kind: 'holiday' });

export const EXPECTED_STUBS: readonly ExpectedStub[] = [
  // Session Mon 2012-01-02 (New Year holiday): one gold minute at Sun 18:06 NY
  holiday('XAU/USD', '2012-01-01 17:00', 1),
  // Session Tue 2013-01-01: trading on New Year's Eve 2012, 17:00-19:00 NY
  holiday('EUR/USD', '2012-12-31 17:00', 16),
  holiday('GBP/USD', '2012-12-31 17:00', 8),
  holiday('USD/JPY', '2012-12-31 17:00', 22),
  holiday('XAU/USD', '2012-12-31 17:00', 26),
  // Sunday 16:59 NY minutes: EUR/USD 6, GBP/USD 4, USD/JPY 10
  sunday('USD/JPY', '2013-01-19'),
  sunday('GBP/USD', '2013-02-02'),
  sunday('GBP/USD', '2013-02-23'),
  sunday('USD/JPY', '2013-02-23'),
  sunday('USD/JPY', '2013-04-06'),
  sunday('EUR/USD', '2013-04-20'),
  sunday('GBP/USD', '2013-06-22'),
  sunday('USD/JPY', '2013-06-29'),
  sunday('USD/JPY', '2013-09-07'),
  sunday('USD/JPY', '2013-11-02'),
  sunday('EUR/USD', '2013-11-23'),
  sunday('USD/JPY', '2013-11-23'),
  sunday('USD/JPY', '2014-01-25'),
  sunday('EUR/USD', '2014-02-01'),
  sunday('EUR/USD', '2014-02-08'),
  sunday('EUR/USD', '2014-06-07'),
  sunday('GBP/USD', '2014-06-07'),
  sunday('USD/JPY', '2014-06-07'),
  sunday('EUR/USD', '2015-02-14'),
  sunday('USD/JPY', '2015-02-14'),
];

// Calendar arithmetic on 'YYYY-MM-DD' strings, in UTC so no local DST applies
function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Western (Gregorian) Easter Sunday: anonymous Gregorian algorithm (Meeus/Jones/Butcher)
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// The holiday trading days of a year on which a short session is accepted
export function holidayDates(year: number): string[] {
  const easter = easterSunday(year);
  return [
    `${year}-01-01`, `${year}-01-02`,
    addDays(easter, -2), // Good Friday
    addDays(easter, 1),  // Easter Monday
    `${year}-12-24`, `${year}-12-25`, `${year}-12-26`, `${year}-12-31`,
  ];
}

// The kind of stub a bar can be, or null if no stub is allowed there
export function classifyStub(nyStart: string): StubKind | null {
  const [date, time] = nyStart.split(' ');
  if (time !== '17:00') return null; // every D1 bar starts at 17:00 NY
  const session = addDays(date, 1);
  const weekday = new Date(`${session}T00:00:00Z`).getUTCDay();
  if (weekday === 0) return 'sunday';
  if (weekday === 6) return null; // a Saturday is never a trading day, holiday list or not
  return holidayDates(Number(session.slice(0, 4))).includes(session) ? 'holiday' : null;
}

export interface Coverage {
  pair: string;
  firstDate: string; // NY dates of the first and last imported minute of a pair-year
  lastDate: string;
}

export interface StubEvaluation {
  ok: boolean;
  lines: string[];
}

const key = (s: Stub) => `${s.pair} ${s.nyStart} ${s.minutes}`;

// Compares the stubs found with the named list. A listed stub is required only
// where its pair is imported (its start or session date inside a pair-year's
// first..last NY date), so partial imports are checked against their share.
export function evaluateStubs(found: Stub[], coverage: Coverage[]): StubEvaluation {
  const covered = (s: Stub) => {
    const start = s.nyStart.slice(0, 10);
    const session = addDays(start, 1);
    return coverage.some((c) => c.pair === s.pair &&
      ((start >= c.firstDate && start <= c.lastDate) || (session >= c.firstDate && session <= c.lastDate)));
  };
  const required = EXPECTED_STUBS.filter(covered);
  const foundKeys = new Set(found.map(key));
  const requiredKeys = new Set(required.map(key));
  const missing = required.filter((s) => !foundKeys.has(key(s)));
  const unexpected = found.filter((s) => !requiredKeys.has(key(s)));
  const count = (stubs: Stub[], kind: StubKind) => stubs.filter((s) => classifyStub(s.nyStart) === kind).length;

  const lines = [
    `Stubs (< 60 minutes): ${found.length}; Sunday 16:59 NY ${count(found, 'sunday')} ` +
      `(expected ${count(required, 'sunday')}), holiday sessions ${count(found, 'holiday')} ` +
      `(expected ${count(required, 'holiday')})`,
    ...found.map((s) => `  ${unexpected.includes(s) ? 'UNEXPECTED ' : ''}${classifyStub(s.nyStart) ?? 'not allowed'}: ` +
      `${s.pair} D1 starting ${s.nyStart} NY, ${s.minutes} min`),
    ...missing.map((s) => `  MISSING ${s.kind}: ${s.pair} D1 starting ${s.nyStart} NY, ${s.minutes} min`),
  ];
  return { ok: missing.length === 0 && unexpected.length === 0, lines };
}
