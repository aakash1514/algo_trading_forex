// Opt-in: records the official calendar pages the economic calendar parses (FOMC, ECB) as test fixtures,
// byte for byte, into apps/domain-service/src/economic-calendar/__fixtures__/, and prints their sha256 for
// the fixtures README. Uses the service's own URLs and User-Agent, waits 5 s between hosts (the ECB's
// robots.txt crawl delay), and writes nothing unless every response is HTTP 200. The default test suite
// never makes these requests.
//
// From the repo root:
//   npx ts-node --transpile-only tools/ops/record-calendar-fixtures.ts
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CALENDAR_USER_AGENT, OFFICIAL_SOURCES } from '../../apps/domain-service/src/economic-calendar/official-sources';

const OUT = join(__dirname, '../../apps/domain-service/src/economic-calendar/__fixtures__');
const FILES = { FOMC: 'fomccalendars.htm', ECB: 'ecb-mgcgc-index.en.html' } as const;

async function main(): Promise<void> {
  const bodies: [string, Buffer][] = [];
  for (const [i, source] of Object.values(OFFICIAL_SOURCES).entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, 5_000));
    const res = await fetch(source.url, { headers: { 'User-Agent': CALENDAR_USER_AGENT } });
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
