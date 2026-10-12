import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Step 6a removed the third-party weekly calendar feed whose terms were never confirmed. Nothing in the
// repository may refer to it again: code, config, fixtures or docs. Every file git tracks or would track
// (untracked but not ignored) is searched. The names are built from pieces so this file doesn't match.
const REPO_ROOT = join(__dirname, '../../../..');
const BANNED = new RegExp(['fair' + 'economy', 'forex' + '\\s*factory', 'ff_' + 'calendar'].join('|'), 'i');

describe('the removed third-party calendar feed', () => {
  it('is detected by the pattern', () => {
    for (const text of ['https://nfs.' + 'fair' + 'economy.media/x.json', 'Forex' + 'Factory', 'forex ' + 'factory', 'ff_' + 'calendar_thisweek']) {
      expect(text).toMatch(BANNED);
    }
    expect('economic calendar from the FOMC and the ECB').not.toMatch(BANNED);
  });

  it('is referenced nowhere in the repository', () => {
    const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: REPO_ROOT })
      .toString('utf8').split('\0').filter(Boolean);
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain('apps/domain-service/src/economic-calendar/official-calendar.service.ts');
    const hits = files.filter((file) => {
      try {
        return BANNED.test(readFileSync(join(REPO_ROOT, file), 'utf8'));
      } catch {
        return false; // listed but deleted in the working tree
      }
    });
    expect(hits).toEqual([]);
  });
});
