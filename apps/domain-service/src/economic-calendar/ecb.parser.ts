import { CalendarParseError, ECB_DECISION_TIME, type OfficialEvent } from './official-sources';
import { classifyImpact } from './impact';
import { zonedToUtc } from './zoned-time';

// Parses the ECB's "Schedules for the meetings of the Governing Council and General Council of the ECB
// and related press conferences" page: a definition list of <dt>DD/MM/YYYY</dt><dd>description</dd>.
// Every entry is validated, but only the monetary policy decisions become events: the meeting's Day 2,
// "followed by press conference", at the ECB's documented decision time (ECB_DECISION_TIME, 14:15 Frankfurt).
// The other entries (Day 1, non-monetary policy and General Council meetings, a press conference listed on
// its own) have no published release time and are skipped. The ECB's own description is the title. Throws
// CalendarParseError on anything unexpected, so a changed page never produces wrong events (the service
// keeps the last good ones).

const LIST = /<div class="definition-list -zebra">\s*<dl>([\s\S]*?)<\/dl>/;
const ENTRY = /<dt>([\s\S]*?)<\/dt>\s*<dd>([\s\S]*?)<\/dd>/g;
const DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const DECISION = /^Governing Council of the ECB: monetary policy meeting in .+ \(Day 2\), followed by press conference$/;

const ENTITIES: Record<string, string> = { '&amp;': '&', '&nbsp;': ' ', '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>' };

function text(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e] ?? e).replace(/\s+/g, ' ').trim();
}

export function parseEcbCalendar(html: string): OfficialEvent[] {
  const list = LIST.exec(html);
  if (!list) throw new CalendarParseError('ECB: meeting schedule list not found');
  const entries = [...list[1].matchAll(ENTRY)];
  if (entries.length === 0) throw new CalendarParseError('ECB: the meeting schedule list is empty');

  const events: OfficialEvent[] = [];
  for (const [, dt, dd] of entries) {
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
    if (!DECISION.test(title)) continue;
    const { time, zone, timeSource } = ECB_DECISION_TIME;
    events.push({
      source: 'ECB', title, currency: 'EUR', scheduledAt: zonedToUtc(`${year}-${month}-${day}`, time, zone).toISOString(),
      timeSource, impact: classifyImpact('ECB'),
    });
  }
  if (events.length === 0) throw new CalendarParseError('ECB: no monetary policy decision found in the schedule');
  return events;
}
