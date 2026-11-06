import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FOMC_EXPECTED_TIME } from './official-sources';
import { parseFomcCalendar } from './fomc.parser';

// The evidence for the EXPECTED FOMC decision time: the statement press releases of the 8 most recent
// scheduled meetings, recorded once on 2026-11-06 (__fixtures__/README.md). The service never fetches them.
const DIR = join(__dirname, '__fixtures__', 'fomc-statements');

const RECORDED: Record<string, string> = {
  'monetary20261028a.htm': 'd8c2677aaf339cafd65a13a732d948fe64d04067d4ad5fa6336768ced81fe291',
  'monetary20260916a.htm': '4a34ebbef9fade34a69f62d8d65e2ccb5062cdd3a562d62d8e29ed594b738f7e',
  'monetary20260729a.htm': 'd543d371bbaddf5e3149d3920a952336bed1df3fb4c05adb7e6bb25d85e57eab',
  'monetary20260617a.htm': 'e9c6128e59b063223d94a77ef6b525be71f558dcd068673dd46e8ce2aa461af0',
  'monetary20260429a.htm': '30b336ad76e81626aa914ed349bb40f4e06e9b3b73a790ad511138f283f09fce',
  'monetary20260318a.htm': 'c0fc7d6e8f60727a423c7f2811730fa2935ef6186099f451effcea242d4c9777',
  'monetary20260128a.htm': '3f2ddb932e04042717e6180fdd4e452c9b101affc867ecd98cb796e710fd0339',
  'monetary20251210a.htm': '9e10cfd8209d8ae0a90c63adcca8b4786a72148518fd93fd319416d2be483250',
};

// <p class="releaseTime">For release at 2:00 p.m. EDT
const RELEASE_TIME = /<p class="releaseTime">\s*For release at ([^<]*)/;

function releaseTime(html: string): string | null {
  const m = RELEASE_TIME.exec(html);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

describe('FOMC expected decision time: recorded statement evidence', () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.htm')).sort();

  it('is exactly the 8 recorded statements, byte for byte', () => {
    expect(files).toHaveLength(8);
    expect(files).toEqual(Object.keys(RECORDED).sort());
    for (const file of files) {
      expect(createHash('sha256').update(readFileSync(join(DIR, file))).digest('hex')).toBe(RECORDED[file]);
    }
  });

  it('every statement says "For release at 2:00 p.m." Eastern (EST or EDT)', () => {
    const times = files.map((file) => releaseTime(readFileSync(join(DIR, file), 'utf8')));
    expect(times.length).toBe(8);
    for (const t of times) expect(t).toMatch(/^2:00 p\.m\. E[SD]T$/);
    // both sides of a US DST change are covered
    expect(new Set(times)).toEqual(new Set(['2:00 p.m. EST', '2:00 p.m. EDT']));
    expect(FOMC_EXPECTED_TIME).toMatchObject({ time: '14:00', zone: 'America/New_York', timeSource: 'expected' });
  });

  it('each statement is from the final day of a scheduled meeting on the recorded FOMC calendar', () => {
    const calendar = parseFomcCalendar(readFileSync(join(__dirname, '__fixtures__', 'fomccalendars.htm'), 'utf8'));
    const meetingDays = new Set(calendar.map((e) => e.scheduledAt.slice(0, 10).replace(/-/g, '')));
    for (const file of files) expect(meetingDays.has(/monetary(\d{8})a/.exec(file)?.[1] ?? '')).toBe(true);
  });

  it('the extractor finds nothing in a page without the release line (fails on empty input)', () => {
    expect(releaseTime('')).toBeNull();
    expect(releaseTime('<p class="releaseTime">For release at 2:15 p.m. EDT</p>')).toBe('2:15 p.m. EDT');
  });
});
