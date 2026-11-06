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
  const in2026 = events.filter((e) => e.scheduledAt.startsWith('2026-'));

  it('finds the 2026 scheduled meetings, at the expected 2:00 p.m. New York time on the final day, in UTC', () => {
    expect(in2026.map((e) => [e.scheduledAt, e.title])).toEqual([
      ['2026-01-28T19:00:00.000Z', 'FOMC meeting, January 27-28'],
      // 18 Mar 2026: US on EDT since 8 Mar, the EU not until 29 Mar
      ['2026-03-18T18:00:00.000Z', 'FOMC meeting, March 17-18, with Summary of Economic Projections'],
      ['2026-04-29T18:00:00.000Z', 'FOMC meeting, April 28-29'],
      ['2026-06-17T18:00:00.000Z', 'FOMC meeting, June 16-17, with Summary of Economic Projections'],
      ['2026-07-29T18:00:00.000Z', 'FOMC meeting, July 28-29'],
      ['2026-09-16T18:00:00.000Z', 'FOMC meeting, September 15-16, with Summary of Economic Projections'],
      ['2026-10-28T18:00:00.000Z', 'FOMC meeting, October 27-28'],
      ['2026-12-09T19:00:00.000Z', 'FOMC meeting, December 8-9, with Summary of Economic Projections'],
    ]);
    expect(in2026.every((e) => e.source === 'FOMC' && e.currency === 'USD' && e.impact === 'HIGH'
      && e.timeSource === 'expected')).toBe(true);
  });

  it('reads every year panel on the page, including meetings that span two months', () => {
    expect(new Set(events.map((e) => e.scheduledAt.slice(0, 4)))).toEqual(
      new Set(['2021', '2022', '2023', '2024', '2025', '2026', '2027']),
    );
    const spanning = events.filter((e) => /^FOMC meeting, [A-Z][a-z]{2}\/[A-Z][a-z]{2} /.test(e.title));
    expect(spanning.length).toBeGreaterThan(0);
    for (const e of spanning) {
      const endDay = Number(/ \d{1,2}-(\d{1,2})/.exec(e.title)?.[1]);
      expect(Number(e.scheduledAt.slice(8, 10))).toBe(endDay); // dated in the second month
    }
  });

  it('skips notation votes (no release time to expect)', () => {
    expect(FOMC_HTML).toContain('22 (notation vote)');
    expect(events.some((e) => e.scheduledAt.startsWith('2025-08-22'))).toBe(false);
    expect(events.some((e) => /notation|unscheduled/i.test(e.title))).toBe(false);
  });

  it('throws instead of guessing when the page changes', () => {
    expect(() => parseFomcCalendar('')).toThrow(CalendarParseError);
    expect(() => parseFomcCalendar(FOMC_HTML.replace(/fomc-meeting__date/g, 'renamed'))).toThrow(/has no meetings/);
    expect(() => parseFomcCalendar(FOMC_HTML.replace('>27-28<', '>27 to 28<'))).toThrow(/unexpected date "27 to 28"/);
    expect(() => parseFomcCalendar(FOMC_HTML.replace('22 (notation vote)', '22 (conference call)')))
      .toThrow(/unexpected note "conference call"/);
  });
});

describe('parseEcbCalendar (ecb.europa.eu meeting schedule)', () => {
  const events = parseEcbCalendar(ECB_HTML);

  it('keeps only the monetary policy decisions, at 14:15 Frankfurt time in UTC, with the ECB description', () => {
    expect(events).toHaveLength(18);
    expect(events[0]).toEqual({
      source: 'ECB', currency: 'EUR', impact: 'HIGH', timeSource: 'official',
      // 29 Oct 2026: Frankfurt back on CET since 25 Oct (the US switches on 1 Nov)
      scheduledAt: '2026-10-29T13:15:00.000Z',
      title: 'Governing Council of the ECB: monetary policy meeting in Frankfurt (Day 2), followed by press conference',
    });
    expect(events.every((e) => /monetary policy meeting.*\(Day 2\), followed by press conference$/.test(e.title))).toBe(true);
  });

  it('uses CEST (UTC+2) in summer and CET (UTC+1) in winter', () => {
    const times = new Set(events.map((e) => e.scheduledAt.slice(11, 16)));
    expect(times).toEqual(new Set(['13:15', '12:15']));
    for (const e of events) {
      const month = Number(e.scheduledAt.slice(5, 7));
      if (month >= 5 && month <= 9) expect(e.scheduledAt.slice(11, 16)).toBe('12:15');
      if (month <= 2 || month >= 11) expect(e.scheduledAt.slice(11, 16)).toBe('13:15');
    }
  });

  it('skips the entries without a published release time', () => {
    expect(ECB_HTML).toContain('(Day 1)');
    expect(ECB_HTML).toContain('non-monetary policy meeting');
    expect(ECB_HTML).toContain('Press conference following the Governing Council meeting');
    expect(events.some((e) => /Day 1|non-monetary|General Council|^Press conference/.test(e.title))).toBe(false);
  });

  it('throws instead of guessing when the page changes', () => {
    expect(() => parseEcbCalendar('')).toThrow(/schedule list not found/);
    expect(() => parseEcbCalendar(ECB_HTML.replace('28/10/2026', '2026-10-28'))).toThrow(/unexpected date "2026-10-28"/);
    expect(() => parseEcbCalendar(ECB_HTML.replace(/followed by press conference/g, 'followed by a press conference')))
      .toThrow(/no monetary policy decision/);
  });
});

describe('classifyImpact (ForexEdge classification)', () => {
  it('maps each stored kind of event to a fixed level', () => {
    expect(classifyImpact('FOMC')).toBe('HIGH');
    expect(classifyImpact('ECB')).toBe('HIGH');
  });
});
