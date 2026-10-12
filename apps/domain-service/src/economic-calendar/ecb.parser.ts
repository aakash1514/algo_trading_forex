import { CalendarParseError, type OfficialEvent } from './official-sources';
import { classifyImpact } from './impact';

// Parses the ECB's "Schedules for the meetings of the Governing Council and General Council of the ECB
// and related press conferences" page: a definition list of <dt>DD/MM/YYYY</dt><dd>description</dd>.
// One event per entry, with the ECB's own description as the title. Throws CalendarParseError on anything
// unexpected, so a changed page never produces wrong events (the service keeps the last good ones).

const LIST = /<div class="definition-list -zebra">\s*<dl>([\s\S]*?)<\/dl>/;
const ENTRY = /<dt>([\s\S]*?)<\/dt>\s*<dd>([\s\S]*?)<\/dd>/g;
const DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/;

const ENTITIES: Record<string, string> = { '&amp;': '&', '&nbsp;': ' ', '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>' };

function text(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e] ?? e).replace(/\s+/g, ' ').trim();
}

export function parseEcbCalendar(html: string): OfficialEvent[] {
  const list = LIST.exec(html);
  if (!list) throw new CalendarParseError('ECB: meeting schedule list not found');
  const entries = [...list[1].matchAll(ENTRY)];
  if (entries.length === 0) throw new CalendarParseError('ECB: the meeting schedule list is empty');

  const events = entries.map(([, dt, dd]): OfficialEvent => {
    const dateText = text(dt);
    const m = DATE.exec(dateText);
    if (!m) throw new CalendarParseError(`ECB: unexpected date "${dateText}"`);
    const [, day, month, year] = m;
    const d = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    if (d.getUTCDate() !== Number(day) || d.getUTCMonth() !== Number(month) - 1) {
      throw new CalendarParseError(`ECB: invalid date "${dateText}"`);
    }
    const title = text(dd);
    if (!title) throw new CalendarParseError(`ECB: entry on ${dateText} has no description`);
    if (title.length > 200) throw new CalendarParseError(`ECB: description on ${dateText} is longer than 200 characters`);
    return { source: 'ECB', title, currency: 'EUR', date: `${year}-${month}-${day}`, impact: classifyImpact('ECB', title) };
  });
  if (!events.some((e) => e.impact === 'HIGH')) {
    throw new CalendarParseError('ECB: no monetary policy meeting found in the schedule');
  }
  return events;
}
