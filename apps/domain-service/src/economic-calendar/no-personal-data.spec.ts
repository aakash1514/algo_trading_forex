import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DataSource } from 'typeorm';
import type Redis from 'ioredis';
import { OfficialCalendarService, type PageFetcher } from './official-calendar.service';
import { CALENDAR_USER_AGENT } from './official-sources';

// The owner's personal data never goes into outbound requests or the repository (CLAUDE.md, personal-data rule).
// Currently no outbound request carries personal data; the calendar is domain-service's only outbound HTTP.
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

describe('calendar User-Agents', () => {
  it('carry no email address for any source (FOMC, ECB and the third-party export)', async () => {
    const seen: [string, string][] = [];
    const fetcher: PageFetcher = async (url, userAgent) => {
      seen.push([url, userAgent]);
      return { status: 503, contentType: 'text/plain', body: '' };
    };
    const redis = { set: jest.fn(async () => 'OK') };
    const service = new OfficialCalendarService({} as DataSource, redis as unknown as Redis);
    service.fetcher = fetcher;
    await service.syncAll(new Date('2026-11-06T06:15:00Z'));

    // one request per source: the Fed, the ECB and the third-party export
    expect(seen).toHaveLength(3);
    expect(new Set(seen.map(([url]) => new URL(url).hostname)).size).toBe(3);
    expect(seen.slice(0, 2).map(([url]) => new URL(url).hostname)).toEqual(['www.federalreserve.gov', 'www.ecb.europa.eu']);
    for (const [, userAgent] of seen) {
      expect(userAgent).toBe(CALENDAR_USER_AGENT);
      expect(userAgent.match(EMAIL)).toBeNull();
    }
    // the pattern does find an address (positive control)
    expect('ForexEdge (+https://example.org; someone@example.org)'.match(EMAIL)).toEqual(['someone@example.org']);
  });
});

// The owner's email addresses, as sha256 of the lowercased address, so this file doesn't contain them.
const OWNER_EMAIL_SHA256 = new Set([
  'f61c6af1985968520587a4fda15f12463bc340e47b97f9e787f6e080779a208a',
  'c73eede808a76225c4189d921c26bf07b256b5b4154ca13a2230e3ba679aaed0',
]);
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const REPO_ROOT = join(__dirname, '../../../..');

describe('the owner’s email addresses', () => {
  it('appear in no tracked file of the repository', () => {
    const files = execFileSync('git', ['ls-files', '--cached', '-z'], { cwd: REPO_ROOT })
      .toString('utf8').split('\0').filter(Boolean);
    expect(files.length).toBeGreaterThan(500);
    let addresses = 0;
    const hits: string[] = [];
    for (const file of files) {
      let text: string;
      try {
        text = readFileSync(join(REPO_ROOT, file), 'utf8');
      } catch {
        continue; // listed but deleted in the working tree
      }
      for (const address of text.match(EMAIL) ?? []) {
        addresses++;
        if (OWNER_EMAIL_SHA256.has(sha256(address.toLowerCase()))) hits.push(file);
      }
    }
    // the scan sees addresses (test users, example.com), so an empty scan can't pass
    expect(addresses).toBeGreaterThan(0);
    expect(hits).toEqual([]);
  });
});
