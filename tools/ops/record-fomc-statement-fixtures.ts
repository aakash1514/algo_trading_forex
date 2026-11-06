// Opt-in, run once: records the FOMC statement press releases of the 8 most recent scheduled meetings (as of
// 2026-11-06) as test fixtures, byte for byte, into
// apps/domain-service/src/economic-calendar/__fixtures__/fomc-statements/, and prints their sha256 for the
// fixtures README. They are the evidence for the calendar's EXPECTED FOMC decision time (the Fed publishes
// no standing release time; fomc-statement-evidence.spec.ts checks every page says "For release at 2:00 p.m.").
// The service never fetches statement pages. federalreserve.gov has no robots.txt (a 404 page, checked
// 2026-11-06). Waits 5 s between requests and writes nothing unless every response is HTTP 200.
//
// From the repo root:
//   npx ts-node --transpile-only tools/ops/record-fomc-statement-fixtures.ts
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CALENDAR_USER_AGENT } from '../../apps/domain-service/src/economic-calendar/official-sources';

const OUT = join(__dirname, '../../apps/domain-service/src/economic-calendar/__fixtures__/fomc-statements');
// Final days of the scheduled meetings on the FOMC calendar (fomccalendars.htm), newest first
const STATEMENT_DAYS = ['20261028', '20260916', '20260729', '20260617', '20260429', '20260318', '20260128', '20251210'];

const url = (day: string) => `https://www.federalreserve.gov/newsevents/pressreleases/monetary${day}a.htm`;

async function main(): Promise<void> {
  const bodies: [string, Buffer][] = [];
  for (const [i, day] of STATEMENT_DAYS.entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, 5_000));
    const res = await fetch(url(day), { headers: { 'User-Agent': CALENDAR_USER_AGENT } });
    if (res.status !== 200) throw new Error(`${url(day)}: HTTP ${res.status}; nothing written`);
    bodies.push([`monetary${day}a.htm`, Buffer.from(await res.arrayBuffer())]);
  }
  mkdirSync(OUT, { recursive: true });
  for (const [file, body] of bodies) {
    writeFileSync(join(OUT, file), body);
    console.log(`${file}  ${body.length} bytes  sha256 ${createHash('sha256').update(body).digest('hex')}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
