import { CalendarParseError } from './official-sources';

// Converts a local wall-clock time in an IANA time zone (e.g. 08:30 in America/New_York) to the UTC instant,
// with the zone's own daylight-saving rules from the runtime's time zone database (Intl), never a fixed
// offset. A local time that doesn't exist (skipped by a DST change) or happens twice (repeated by one)
// throws, so an ambiguous release time is never resolved by a guess.

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^(\d{2}):(\d{2})$/;
const HOUR_MS = 60 * 60 * 1000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(zone, f);
  }
  return f;
}

// The zone's UTC offset (local minus UTC, in ms) at a UTC instant
function offsetAt(zone: string, utcMs: number): number {
  const parts = Object.fromEntries(formatter(zone).formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]));
  const local = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return local - utcMs;
}

export function zonedToUtc(date: string, time: string, zone: string): Date {
  const d = DATE.exec(date);
  const t = TIME.exec(time);
  if (!d || !t) throw new CalendarParseError(`Invalid local date/time "${date} ${time}"`);
  const [y, mo, day, h, mi] = [+d[1], +d[2], +d[3], +t[1], +t[2]];
  const wall = Date.UTC(y, mo - 1, day, h, mi);
  const check = new Date(wall);
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== day || h > 23 || mi > 59) {
    throw new CalendarParseError(`Invalid local date/time "${date} ${time}"`);
  }
  // The offsets a day either side cover both sides of any DST change near this time
  const offsets = new Set([offsetAt(zone, wall - 24 * HOUR_MS), offsetAt(zone, wall + 24 * HOUR_MS)]);
  const instants = [...offsets].map((o) => wall - o).filter((utc) => wall - offsetAt(zone, utc) === utc);
  const unique = [...new Set(instants)];
  if (unique.length === 0) throw new CalendarParseError(`${date} ${time} does not exist in ${zone} (DST change)`);
  if (unique.length > 1) throw new CalendarParseError(`${date} ${time} is ambiguous in ${zone} (DST change)`);
  return new Date(unique[0]);
}
