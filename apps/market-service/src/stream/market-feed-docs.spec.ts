import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseMarketFeed } from '@forexedge/common';

// MARKET_FEED replaced the old simulated-feed flag in step 6a. The old flag may appear nowhere in code, config
// or the top-level docs: only the step 6a phase summary explains the rename (and docs/ keeps the historical
// reports as written). Every file git tracks or would track (untracked but not ignored) outside docs/ is
// searched. The flag's name is built from pieces so this file doesn't match.
const REPO_ROOT = join(__dirname, '../../../..');
const OLD_FLAG = ['USE', 'MOCK', 'DATA'].join('_');

function repoFiles(): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: REPO_ROOT })
    .toString('utf8').split('\0').filter(Boolean);
}

function read(file: string): string | null {
  try {
    return readFileSync(join(REPO_ROOT, file), 'utf8');
  } catch {
    return null; // listed but deleted in the working tree
  }
}

describe('the old simulated-feed flag', () => {
  it('appears in no code, config, README or CLAUDE.md', () => {
    const files = repoFiles().filter((f) => !f.startsWith('docs/'));
    expect(files.length).toBeGreaterThan(500);
    for (const required of ['.env.example', 'README.md', 'CLAUDE.md', 'apps/market-service/src/stream/stream.module.ts']) {
      expect(files).toContain(required);
    }
    const hits = files.filter((file) => read(file)?.includes(OLD_FLAG));
    expect(hits).toEqual([]);
  });

  it('is detected by the search (positive control)', () => {
    const summary = read('docs/phase-summaries/step-6a-price-safety-calendar.md');
    expect(summary).not.toBeNull();
    expect(summary).toContain(OLD_FLAG);
  });
});

describe('MARKET_FEED docs', () => {
  it('match the parser: none (default) or mock, anything else fails startup', () => {
    expect(parseMarketFeed(undefined)).toBe('none');
    expect(parseMarketFeed('mock')).toBe('mock');
    expect(() => parseMarketFeed('twelve_data')).toThrow('MARKET_FEED must be "none" or "mock"');

    const envExample = read('.env.example') ?? '';
    expect(envExample).toMatch(/^MARKET_FEED=none$/m);
    expect(envExample).toContain('# none (default)');
    expect(envExample).toContain('# mock:');
    expect(envExample).toContain('# Any other value fails startup.');

    const readme = read('README.md') ?? '';
    expect(readme).toContain('`MARKET_FEED=none|mock`');
    expect(readme).toContain('`none` is the default');
    expect(readme).toContain('Any other value fails startup.');

    const claude = read('CLAUDE.md') ?? '';
    expect(claude).toContain('`MARKET_FEED` must be exactly `none` (the\n  default, also when unset) or `mock`; anything else fails startup.');
  });
});
