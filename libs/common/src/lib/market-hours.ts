// Market hours and trading sessions, shared by domain-service (session events)
// and order-service (order stamping and the market-closed gate). Pure functions
// of the clock: there is no state to lose on restart.
//
// Rules (New York time, DST-aware via the IANA zone; checked against 13 years of
// Dukascopy data, 2010-2022):
// - FX trades from Sunday 17:00 to Friday 17:00 New York.
// - Metals (XAU/USD) close at the same Friday 17:00 but open on Sunday at 18:00,
//   and pause daily from 17:00 to 18:00 Monday-Thursday (no traded minutes in
//   that hour from 2013 on).
// - Holidays (Christmas, New Year) are not modelled.

export type ForexSession = 'SYDNEY' | 'TOKYO' | 'LONDON' | 'NEW_YORK';
export type MarketClosedReason = 'WEEKEND' | 'DAILY_BREAK';
// instruments.type values; only METAL has its own hours.
export type InstrumentKind = 'MAJOR' | 'MINOR' | 'EXOTIC' | 'METAL';

export interface MarketStatus {
  open: boolean;
  reason?: MarketClosedReason;
  reopensAt?: Date; // when closed
}

const NEW_YORK = 'America/New_York';
const LONDON = 'Europe/London';
const MS_PER_MINUTE = 60_000;

// Session windows in UTC hours, standard time (open inclusive, close exclusive).
// London shifts an hour earlier during BST, New York during EDT; Sydney and
// Tokyo are not adjusted (unchanged from the original domain-service clock).
const SESSION_WINDOWS: { session: ForexSession; open: number; close: number }[] = [
  { session: 'SYDNEY', open: 21, close: 6 },
  { session: 'TOKYO', open: 0, close: 9 },
  { session: 'LONDON', open: 8, close: 16 },
  { session: 'NEW_YORK', open: 13, close: 22 },
];

interface ZonedParts {
  weekday: number; // 0 = Sunday ... 6 = Saturday
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function zoned(date: Date, timeZone: string): ZonedParts {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(date).map((p) => [p.type, p.value]));
  return {
    weekday: WEEKDAYS.indexOf(parts['weekday']),
    year: Number(parts['year']),
    month: Number(parts['month']),
    day: Number(parts['day']),
    hour: Number(parts['hour']),
    minute: Number(parts['minute']),
  };
}

// UTC offset of `timeZone` at `date`, in minutes (New York: -300 EST, -240 EDT).
function offsetMinutes(date: Date, timeZone: string): number {
  const p = zoned(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return Math.round((asUtc - Math.floor(date.getTime() / MS_PER_MINUTE) * MS_PER_MINUTE) / MS_PER_MINUTE);
}

// The instant of a New York wall-clock time (never in a DST gap here: markets
// open and close at 17:00/18:00, DST changes at 02:00).
function newYorkTime(year: number, month: number, day: number, hour: number): Date {
  const guess = Date.UTC(year, month - 1, day, hour);
  const first = guess - offsetMinutes(new Date(guess), NEW_YORK) * MS_PER_MINUTE;
  return new Date(guess - offsetMinutes(new Date(first), NEW_YORK) * MS_PER_MINUTE);
}

// The New York calendar date `days` after the one in `p` (calendar arithmetic in UTC).
function addDays(p: ZonedParts, days: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

// Minutes since Sunday 00:00 New York, the unit the weekly rules are written in.
function weekMinute(p: ZonedParts): number {
  return (p.weekday * 24 + p.hour) * 60 + p.minute;
}

const at = (weekday: number, hour: number) => (weekday * 24 + hour) * 60;
const FRIDAY_CLOSE = at(5, 17);
const SUNDAY_OPEN_FX = at(0, 17);
const SUNDAY_OPEN_METAL = at(0, 18);

export function marketStatus(kind: InstrumentKind, now: Date = new Date()): MarketStatus {
  const p = zoned(now, NEW_YORK);
  const minute = weekMinute(p);
  const metal = kind === 'METAL';
  const sundayOpen = metal ? SUNDAY_OPEN_METAL : SUNDAY_OPEN_FX;

  // Weekend: Friday 17:00 to the Sunday open
  if (minute >= FRIDAY_CLOSE || minute < sundayOpen) {
    const daysToSunday = (7 - p.weekday) % 7;
    const sunday = addDays(p, daysToSunday);
    return {
      open: false,
      reason: 'WEEKEND',
      reopensAt: newYorkTime(sunday.year, sunday.month, sunday.day, metal ? 18 : 17),
    };
  }

  // Metals: daily break 17:00-18:00, Monday-Thursday
  if (metal && p.weekday >= 1 && p.weekday <= 4 && p.hour === 17) {
    return { open: false, reason: 'DAILY_BREAK', reopensAt: newYorkTime(p.year, p.month, p.day, 18) };
  }

  return { open: true };
}

export function isFxMarketOpen(now: Date = new Date()): boolean {
  return marketStatus('MAJOR', now).open;
}

// Forex sessions active at `now`; none while the FX market is closed.
export function activeSessions(now: Date = new Date()): ForexSession[] {
  if (!isFxMarketOpen(now)) return [];

  const hour = now.getUTCHours() + now.getUTCMinutes() / 60;
  const londonShift = offsetMinutes(now, LONDON) === 60 ? 1 : 0; // BST
  const newYorkShift = offsetMinutes(now, NEW_YORK) === -240 ? 1 : 0; // EDT

  return SESSION_WINDOWS.filter(({ session, open, close }) => {
    const shift = session === 'LONDON' ? londonShift : session === 'NEW_YORK' ? newYorkShift : 0;
    const o = open - shift;
    const c = close - shift;
    return o < c ? hour >= o && hour < c : hour >= o || hour < c; // windows crossing midnight
  }).map(({ session }) => session);
}

// The value stamped on orders.session_opened: "LONDON,NEW_YORK" or "OFF_HOURS".
export function sessionLabel(now: Date = new Date()): string {
  const sessions = activeSessions(now);
  return sessions.length ? sessions.join(',') : 'OFF_HOURS';
}
