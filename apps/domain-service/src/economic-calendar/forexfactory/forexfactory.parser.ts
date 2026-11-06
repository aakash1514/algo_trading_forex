import { CalendarParseError, type OfficialEvent } from '../official-sources';
import { FF_DUPLICATE_TITLES, FF_IMPACT, FF_SKIPPED_IMPACTS } from './forexfactory.source';

// Parses ForexFactory's weekly JSON export: an array of {title, country, date, impact, forecast, previous}, with
// `date` in ISO 8601 with the feed's own UTC offset (e.g. "2026-11-02T22:30:00-05:00"), which is what makes it
// a UTC instant; a date without an offset throws (no zone is ever assumed). Events only: forecast and previous
// are not read. Skipped, and counted by kind:
//   holiday       impact "Holiday" (bank holidays, DST shifts)
//   nonEconomic   impact "Non-Economic"
//   midnight      exactly 00:00:00 local: the export has no time text, and ForexFactory's "All Day" and
//                 "Tentative" entries have no real time (their titles are reported, so a real midnight
//                 release would be visible)
//   duplicate     an FOMC or ECB policy decision (FF_DUPLICATE_TITLES), which the official sources provide
// Throws CalendarParseError on anything unexpected, so a changed or blocked answer never replaces good data.

const DATE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})([+-]\d{2}:\d{2})$/;
const CURRENCY = /^[A-Z]{3}$/;

export interface ForexFactoryWeek {
  events: OfficialEvent[];
  skipped: { holiday: number; nonEconomic: number; midnight: number; duplicate: number };
  midnightTitles: string[];
  // earliest and latest entry of the export, skipped ones included: the week the export replaces
  range: { from: string; to: string };
}

function field(entry: Record<string, unknown>, name: string, i: number): string {
  const value = entry[name];
  if (typeof value !== 'string') throw new CalendarParseError(`ForexFactory: entry ${i} has no string "${name}"`);
  return value;
}

export function parseForexFactoryWeek(body: string, contentType: string | null): ForexFactoryWeek {
  if (!contentType || !/^application\/json\b/i.test(contentType)) {
    throw new CalendarParseError(`ForexFactory: not JSON (content type ${contentType ?? 'none'})`);
  }
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new CalendarParseError('ForexFactory: the body is not valid JSON');
  }
  if (!Array.isArray(data)) throw new CalendarParseError('ForexFactory: the export is not an array');
  if (data.length === 0) throw new CalendarParseError('ForexFactory: the export is empty');

  const week: ForexFactoryWeek = {
    events: [], skipped: { holiday: 0, nonEconomic: 0, midnight: 0, duplicate: 0 }, midnightTitles: [],
    range: { from: '', to: '' },
  };
  let min = Infinity;
  let max = -Infinity;

  data.forEach((raw: unknown, i) => {
    if (typeof raw !== 'object' || raw === null) throw new CalendarParseError(`ForexFactory: entry ${i} is not an object`);
    const entry = raw as Record<string, unknown>;
    const title = field(entry, 'title', i).trim();
    const currency = field(entry, 'country', i);
    const date = field(entry, 'date', i);
    const impact = field(entry, 'impact', i);
    if (!title || title.length > 200) throw new CalendarParseError(`ForexFactory: entry ${i} has an invalid title`);
    if (!CURRENCY.test(currency)) throw new CalendarParseError(`ForexFactory: entry ${i} has currency "${currency}"`);
    const m = DATE.exec(date);
    if (!m) throw new CalendarParseError(`ForexFactory: entry ${i} has date "${date}" without a UTC offset`);
    const at = Date.parse(date);
    if (Number.isNaN(at)) throw new CalendarParseError(`ForexFactory: entry ${i} has an invalid date "${date}"`);
    min = Math.min(min, at);
    max = Math.max(max, at);

    if (impact === 'Holiday') { week.skipped.holiday++; return; }
    if (impact === 'Non-Economic') { week.skipped.nonEconomic++; return; }
    const level = FF_IMPACT[impact];
    if (!level) {
      throw new CalendarParseError(`ForexFactory: entry ${i} has impact "${impact}" (expected High, Medium, Low, ${FF_SKIPPED_IMPACTS.join(', ')})`);
    }
    if (m[4] === '00' && m[5] === '00' && m[6] === '00') {
      week.skipped.midnight++;
      week.midnightTitles.push(`${currency} ${title}`);
      return;
    }
    if (FF_DUPLICATE_TITLES[currency]?.includes(title)) { week.skipped.duplicate++; return; }

    week.events.push({
      source: 'FOREXFACTORY', title, currency, scheduledAt: new Date(at).toISOString(), timeSource: 'third_party',
      impact: level,
    });
  });

  week.range = { from: new Date(min).toISOString(), to: new Date(max).toISOString() };
  return week;
}
