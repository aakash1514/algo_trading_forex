import { CalendarParseError, FOMC_EXPECTED_TIME, type OfficialEvent } from './official-sources';
import { classifyImpact } from './impact';
import { zonedToUtc } from './zoned-time';

// Parses the Federal Reserve's FOMC meeting calendar page (fomccalendars.htm): one panel per year
// ("2026 FOMC Meetings"), each with month/date rows such as "January" / "27-28", "March" / "17-18*",
// "Apr/May" / "30-1" or "August" / "22 (notation vote)". One event per scheduled meeting, at the EXPECTED
// statement time (FOMC_EXPECTED_TIME, 2:00 p.m. New York) on its final day, when the decision is announced.
// Notation votes and unscheduled meetings are skipped (no release time to expect). Throws
// CalendarParseError on anything unexpected, so a changed page never produces wrong events (the service
// keeps the last good ones).

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11,
  november: 11, dec: 12, december: 12,
};

const PANEL = /<h4>\s*<a id="\d+">\s*(\d{4}) FOMC Meetings\s*<\/a>\s*<\/h4>/g;
const ROW = /fomc-meeting__month[^>]*>\s*<strong>([^<]+)<\/strong>\s*<\/div>\s*<div class="fomc-meeting__date[^>]*>([^<]+)<\/div>/g;
const DATE_TEXT = /^(\d{1,2})(?:-(\d{1,2}))?(\*)?(?:\s*\(([^)]+)\))?$/;

const pad = (n: number) => String(n).padStart(2, '0');

// Notes on rows that aren't scheduled meetings; any other note is unexpected
const SKIPPED_NOTES = new Set(['notation vote', 'unscheduled']);

function monthNumber(name: string): number {
  const n = MONTHS[name.trim().toLowerCase()];
  if (!n) throw new CalendarParseError(`FOMC: unknown month "${name}"`);
  return n;
}

function validDate(year: number, month: number, day: number): string {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    throw new CalendarParseError(`FOMC: invalid date ${year}-${month}-${day}`);
  }
  return `${year}-${pad(month)}-${pad(day)}`;
}

export function parseFomcCalendar(html: string): OfficialEvent[] {
  const panels = [...html.matchAll(PANEL)].map((m) => ({ year: Number(m[1]), at: m.index ?? 0 }))
    .sort((a, b) => a.at - b.at);
  if (panels.length === 0) throw new CalendarParseError('FOMC: no "<year> FOMC Meetings" panel found');

  const events: OfficialEvent[] = [];
  panels.forEach((panel, i) => {
    const body = html.slice(panel.at, i + 1 < panels.length ? panels[i + 1].at : undefined);
    const rows = [...body.matchAll(ROW)];
    if (rows.length === 0) throw new CalendarParseError(`FOMC: the ${panel.year} panel has no meetings`);
    for (const [, monthText, rawDate] of rows) {
      const dateText = rawDate.trim();
      const m = DATE_TEXT.exec(dateText);
      if (!m) throw new CalendarParseError(`FOMC: unexpected date "${dateText}" in ${panel.year} ${monthText}`);
      const [, startDay, endDay, sep, note] = m;
      if (note) {
        if (SKIPPED_NOTES.has(note.trim().toLowerCase())) continue;
        throw new CalendarParseError(`FOMC: unexpected note "${note}" in ${panel.year} ${monthText}`);
      }
      const months = monthText.split('/').map(monthNumber);
      if (months.length > 2) throw new CalendarParseError(`FOMC: unexpected month "${monthText}"`);
      const finalMonth = months[months.length - 1];
      // "Dec/Jan" would cross into the next year
      const finalYear = months.length === 2 && finalMonth < months[0] ? panel.year + 1 : panel.year;
      const date = validDate(finalYear, finalMonth, Number(endDay ?? startDay));
      const days = endDay ? `${startDay}-${endDay}` : startDay;
      const title = `FOMC meeting, ${monthText.trim()} ${days}` + (sep ? ', with Summary of Economic Projections' : '');
      const { time, zone, timeSource } = FOMC_EXPECTED_TIME;
      events.push({
        source: 'FOMC', title, currency: 'USD', scheduledAt: zonedToUtc(date, time, zone).toISOString(), timeSource,
        impact: classifyImpact('FOMC'),
      });
    }
  });
  if (events.length === 0) throw new CalendarParseError('FOMC: no scheduled meeting found');
  return events;
}
