// Opt-in: records the official calendar pages the economic calendar parses as test fixtures, byte for byte,
// into apps/domain-service/src/economic-calendar/__fixtures__/, and prints their sha256 for the fixtures
// README. Uses the service's own URLs and User-Agents (BLS: with CALENDAR_CONTACT_EMAIL from the environment,
// refused without it; the value is never printed), waits 5 s between requests (the ECB's robots.txt crawl
// delay), and writes nothing unless every response is HTTP 200. The default test suite never makes these
// requests. Records every source, or only the ones named.
//
// From the repo root (BLS needs the variable from .env in the environment):
//   npx ts-node --transpile-only tools/ops/record-calendar-fixtures.ts [FOMC] [ECB] [BLS_CPI] [BLS_EMPSIT]
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  OFFICIAL_SOURCES, calendarUserAgent, parseContactEmail, type CalendarSource,
} from '../../apps/domain-service/src/economic-calendar/official-sources';

const OUT = join(__dirname, '../../apps/domain-service/src/economic-calendar/__fixtures__');
const FILES: Record<CalendarSource, string> = {
  FOMC: 'fomccalendars.htm',
  ECB: 'ecb-mgcgc-index.en.html',
  BLS_CPI: 'bls-cpi.htm',
  BLS_EMPSIT: 'bls-empsit.htm',
};

async function main(): Promise<void> {
  const named = process.argv.slice(2);
  for (const n of named) if (!(n in OFFICIAL_SOURCES)) throw new Error(`Unknown source "${n}"`);
  const sources = Object.values(OFFICIAL_SOURCES).filter((s) => named.length === 0 || named.includes(s.source));
  const contact = parseContactEmail(process.env['CALENDAR_CONTACT_EMAIL']);
  if (sources.some((s) => s.needsContact) && !contact) {
    throw new Error('CALENDAR_CONTACT_EMAIL is not set: BLS is not fetched without it; nothing requested');
  }

  const bodies: [string, Buffer][] = [];
  for (const [i, source] of sources.entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, 5_000));
    const res = await fetch(source.url, { headers: { 'User-Agent': calendarUserAgent(source, contact ?? '') } });
    if (res.status !== 200) throw new Error(`${source.source}: HTTP ${res.status}; nothing written`);
    bodies.push([FILES[source.source], Buffer.from(await res.arrayBuffer())]);
  }
  for (const [file, body] of bodies) {
    writeFileSync(join(OUT, file), body);
    console.log(`${file}  ${body.length} bytes  sha256 ${createHash('sha256').update(body).digest('hex')}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
