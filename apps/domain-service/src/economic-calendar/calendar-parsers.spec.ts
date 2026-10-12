import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFomcCalendar } from './fomc.parser';
import { parseEcbCalendar } from './ecb.parser';
import { CalendarParseError } from './official-sources';
import { classifyImpact } from './impact';

// Real pages recorded 2026-10-12 (__fixtures__/README.md), byte for byte.
const FIXTURES = join(__dirname, '__fixtures__');
const read = (file: string) => readFileSync(join(FIXTURES, file));
const FOMC_HTML = read('fomccalendars.htm').toString('utf8');
const ECB_HTML = read('ecb-mgcgc-index.en.html').toString('utf8');

describe('recorded calendar fixtures', () => {
  it('are the bytes the README lists', () => {
    const sha = (file: string) => createHash('sha256').update(read(file)).digest('hex');
    expect(sha('fomccalendars.htm')).toBe('f0ebb8076d2c75c0a7b2d4affabf7b4141a3b2968a0ed4431d82ea0ba5ee6028');
    expect(sha('ecb-mgcgc-index.en.html')).toBe('ed2138656be0cd12fa1d8ce86eb89edde8b46e8b3eb3339c0b489a30023eb9ce');
  });
});

describe('parseFomcCalendar (federalreserve.gov fomccalendars.htm)', () => {
  const events = parseFomcCalendar(FOMC_HTML);
  const in2026 = events.filter((e) => e.date.startsWith('2026-'));

  it('finds the 2026 meetings exactly as the page lists them, dated on the final day', () => {
    expect(in2026.map((e) => [e.date, e.title])).toEqual([
      ['2026-01-28', 'FOMC meeting, January 27-28'],
      ['2026-03-18', 'FOMC meeting, March 17-18, with Summary of Economic Projections'],
      ['2026-04-29', 'FOMC meeting, April 28-29'],
      ['2026-06-17', 'FOMC meeting, June 16-17, with Summary of Economic Projections'],
      ['2026-07-29', 'FOMC meeting, July 28-29'],
      ['2026-09-16', 'FOMC meeting, September 15-16, with Summary of Economic Projections'],
      ['2026-10-28', 'FOMC meeting, October 27-28'],
      ['2026-12-09', 'FOMC meeting, December 8-9, with Summary of Economic Projections'],
    ]);
    expect(in2026.every((e) => e.source === 'FOMC' && e.currency === 'USD' && e.impact === 'HIGH')).toBe(true);
  });

  it('reads every year panel on the page, including meetings that span two months', () => {
    expect(new Set(events.map((e) => e.date.slice(0, 4)))).toEqual(
      new Set(['2021', '2022', '2023', '2024', '2025', '2026', '2027']),
    );
    const spanning = events.filter((e) => /^FOMC meeting, [A-Z][a-z]{2}\/[A-Z][a-z]{2} /.test(e.title));
    expect(spanning.length).toBeGreaterThan(0);
    for (const e of spanning) {
      const endDay = Number(/ \d{1,2}-(\d{1,2})/.exec(e.title)?.[1]);
      expect(Number(e.date.slice(8, 10))).toBe(endDay); // dated in the second month
    }
  });

  it('keeps a notation vote, classified LOW', () => {
    const vote = events.find((e) => e.title === 'FOMC meeting, August 22 (notation vote)');
    expect(vote).toMatchObject({ date: '2025-08-22', impact: 'LOW' });
  });

  it('throws instead of guessing when the page changes', () => {
    expect(() => parseFomcCalendar('')).toThrow(CalendarParseError);
    expect(() => parseFomcCalendar(FOMC_HTML.replace(/fomc-meeting__date/g, 'renamed'))).toThrow(/has no meetings/);
    expect(() => parseFomcCalendar(FOMC_HTML.replace('>27-28<', '>27 to 28<'))).toThrow(/unexpected date "27 to 28"/);
  });
});

describe('parseEcbCalendar (ecb.europa.eu meeting schedule)', () => {
  const events = parseEcbCalendar(ECB_HTML);

  it('reads every entry with the ECB description as the title', () => {
    expect(events.length).toBeGreaterThan(10);
    expect(events.slice(0, 3)).toEqual([
      { source: 'ECB', currency: 'EUR', date: '2026-10-28', impact: 'LOW',
        title: 'Governing Council of the ECB: monetary policy meeting in Frankfurt (Day 1)' },
      { source: 'ECB', currency: 'EUR', date: '2026-10-29', impact: 'HIGH',
        title: 'Governing Council of the ECB: monetary policy meeting in Frankfurt (Day 2), followed by press conference' },
      { source: 'ECB', currency: 'EUR', date: '2026-10-29', impact: 'MEDIUM',
        title: 'Press conference following the Governing Council meeting of the ECB in Frankfurt' },
    ]);
  });

  it('marks each monetary policy decision day HIGH and nothing else', () => {
    const high = events.filter((e) => e.impact === 'HIGH').map((e) => e.date);
    expect(high).toEqual(expect.arrayContaining(['2026-10-29', '2026-12-17', '2027-02-04', '2027-03-18']));
    expect(events.filter((e) => e.impact === 'HIGH').every((e) => /monetary policy meeting.*\(Day 2\)/.test(e.title))).toBe(true);
    expect(events.find((e) => e.title.includes('non-monetary policy meeting'))?.impact).toBe('LOW');
  });

  it('throws instead of guessing when the page changes', () => {
    expect(() => parseEcbCalendar('')).toThrow(/schedule list not found/);
    expect(() => parseEcbCalendar(ECB_HTML.replace('28/10/2026', '2026-10-28'))).toThrow(/unexpected date "2026-10-28"/);
    expect(() => parseEcbCalendar(ECB_HTML.replace(/monetary policy meeting/g, 'meeting'))).toThrow(/no monetary policy meeting/);
  });
});

describe('classifyImpact (ForexEdge classification)', () => {
  it('maps titles to fixed levels', () => {
    expect(classifyImpact('FOMC', 'FOMC meeting, January 27-28')).toBe('HIGH');
    expect(classifyImpact('FOMC', 'FOMC meeting, August 22 (notation vote)')).toBe('LOW');
    expect(classifyImpact('ECB', 'Governing Council of the ECB: non-monetary policy meeting (virtual)')).toBe('LOW');
    expect(classifyImpact('ECB', 'General Council meeting of the ECB in Frankfurt')).toBe('LOW');
  });
});
