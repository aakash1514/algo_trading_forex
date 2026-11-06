import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Step 6a removed the old third-party weekly calendar fetcher. On 2026-11-06 the owner approved that site's own
// calendar export for portfolio use (CLAUDE.md, data-licensing exception), as one adapter: economic-calendar/
// forexfactory/. The name may appear only there, where the adapter is wired in and shown (the calendar service
// and sources, the frontend calendar and its recorded responses), and in docs; anywhere else it fails. Every
// file git tracks or would track (untracked but not ignored) is searched. The names are built from pieces so
// the patterns in this file don't match themselves.
const REPO_ROOT = join(__dirname, '../../../..');
const NAME = new RegExp(['fair' + 'economy', 'forex' + '[\\s_-]*factory', 'ff_' + 'calendar'].join('|'), 'i');
const CAL = 'apps/domain-service/src/economic-calendar/';
const ALLOWED: readonly string[] = [
  `${CAL}${'forex' + 'factory'}/`,                       // the adapter, its parser, tests, fixtures and README
  `${CAL}official-calendar.service.ts`,
  `${CAL}official-calendar.service.spec.ts`,
  `${CAL}official-sources.ts`,
  `${CAL}__fixtures__/README.md`,                         // the coverage note
  `${CAL}no-third-party-calendar.spec.ts`,
  'apps/frontend/src/lib/calendar.ts',
  'apps/frontend/src/components/widgets/CalendarClient.tsx',
  'apps/frontend/src/components/widgets/CalendarClient.spec.tsx',
  'apps/frontend/src/components/widgets/__fixtures__/',
  'apps/order-service/src/order/calendar-gate.db.spec.ts', // reads the recorded export
  'tools/market-data/import/src/importer.db.spec.ts',      // the migration walk stores one of its events
  '.gitattributes',                                       // keeps the recorded export's bytes
  'CLAUDE.md',
  'README.md',
  'docs/',
];

const allowed = (file: string) => ALLOWED.some((a) => (a.endsWith('/') ? file.startsWith(a) : file === a));

function repoFiles(): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: REPO_ROOT })
    .toString('utf8').split('\0').filter(Boolean);
}

function mentions(file: string): boolean {
  try {
    return NAME.test(readFileSync(join(REPO_ROOT, file), 'utf8'));
  } catch {
    return false; // listed but deleted in the working tree
  }
}

describe('the third-party calendar name', () => {
  it('is detected by the pattern', () => {
    for (const text of ['https://nfs.' + 'fair' + 'economy.media/x.json', 'Forex' + 'Factory', 'forex ' + 'factory',
      'FOREX' + 'FACTORY', 'ff_' + 'calendar_thisweek']) {
      expect(text).toMatch(NAME);
    }
    expect('economic calendar from the FOMC and the ECB').not.toMatch(NAME);
  });

  it('appears only in its adapter, where it is wired in and shown, and in docs', () => {
    const files = repoFiles();
    expect(files.length).toBeGreaterThan(500);
    const hits = files.filter(mentions);
    // positive control: the adapter itself is found
    expect(hits).toContain(`${CAL}${'forex' + 'factory'}/${'forex' + 'factory'}.source.ts`);
    expect(hits.filter((f) => !allowed(f))).toEqual([]);
  });
});
