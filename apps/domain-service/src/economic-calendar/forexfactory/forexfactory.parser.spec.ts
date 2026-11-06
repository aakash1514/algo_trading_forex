import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CalendarParseError } from '../official-sources';
import { parseForexFactoryWeek } from './forexfactory.parser';
import { FF_DUPLICATE_TITLES } from './forexfactory.source';

// The real export recorded on 2026-11-06 (__fixtures__/README.md), byte for byte.
const FIXTURE = join(__dirname, '__fixtures__', 'ff_calendar_thisweek-2026-11-06.json');
const BODY = readFileSync(FIXTURE, 'utf8');
const JSON_TYPE = 'application/json';

describe('recorded Forex Factory export', () => {
  it('is the bytes the README lists', () => {
    expect(createHash('sha256').update(readFileSync(FIXTURE)).digest('hex'))
      .toBe('8580a420686aa4c908bed876f441c0f8f43a402b845f3f9f4e341df923ad6d49');
  });
});

describe('parseForexFactoryWeek (real export, week of 1-6 Nov 2026)', () => {
  const week = parseForexFactoryWeek(BODY, JSON_TYPE);
  const count = (impact: string) => week.events.filter((e) => e.impact === impact).length;

  it('keeps every timed event, counted by Forex Factory impact', () => {
    expect(JSON.parse(BODY)).toHaveLength(115);
    expect(week.events).toHaveLength(112);
    expect([count('HIGH'), count('MEDIUM'), count('LOW')]).toEqual([19, 15, 78]);
    expect(week.events.every((e) => e.source === 'FOREXFACTORY' && e.timeSource === 'third_party')).toBe(true);
    expect(new Set(week.events.map((e) => e.currency))).toEqual(
      new Set(['USD', 'EUR', 'GBP', 'AUD', 'CAD', 'CHF', 'JPY', 'NZD', 'CNY']));
    // events only: no forecast or previous value is carried
    expect(Object.keys(week.events[0]).sort()).toEqual(['currency', 'impact', 'scheduledAt', 'source', 'timeSource', 'title']);
  });

  it('skips the entries without a real time, by kind', () => {
    expect(week.skipped).toEqual({ holiday: 3, nonEconomic: 0, midnight: 0, duplicate: 0 });
    expect(week.midnightTitles).toEqual([]);
    expect(week.events.some((e) => /Daylight Saving Time Shift|Bank Holiday/.test(e.title))).toBe(false);
  });

  it('converts with the offset the export gives (every entry is -05:00 this week)', () => {
    const rba = week.events.find((e) => e.currency === 'AUD' && e.title === 'RBA Rate Statement');
    expect(rba?.scheduledAt).toBe('2026-11-03T03:30:00.000Z'); // 2026-11-02T22:30:00-05:00
    // The week contains the US DST change (1 Nov, 02:00 New York), but every timed entry comes after it, so
    // this fixture has no event before the change (only the two "Daylight Saving Time Shift" holiday entries).
    expect(new Set((JSON.parse(BODY) as { date: string }[]).map((e) => e.date.slice(-6)))).toEqual(new Set(['-05:00']));
    expect(week.range).toEqual({ from: '2026-11-01T07:00:00.000Z', to: '2026-11-06T21:45:00.000Z' });
  });

  it('keeps the same release for two currencies at the same time', () => {
    const unemployment = week.events.filter((e) => e.title === 'Unemployment Rate' && e.scheduledAt === '2026-11-06T13:30:00.000Z');
    expect(unemployment.map((e) => [e.currency, e.impact]).sort()).toEqual([['CAD', 'HIGH'], ['USD', 'HIGH']]);
  });

  it('drops only FOMC and ECB policy decisions: none this week, and the RBA and BOE decisions are kept', () => {
    expect(FF_DUPLICATE_TITLES).toEqual({
      USD: ['Federal Funds Rate', 'FOMC Statement', 'FOMC Press Conference', 'FOMC Economic Projections'],
      EUR: ['Main Refinancing Rate', 'Monetary Policy Statement', 'ECB Press Conference'],
    });
    const titles = week.events.map((e) => `${e.currency} ${e.title}`);
    for (const kept of ['AUD RBA Rate Statement', 'AUD RBA Monetary Policy Statement', 'AUD RBA Press Conference',
      'GBP BOE Monetary Policy Report', 'GBP Monetary Policy Summary', 'USD FOMC Member Williams Speaks',
      'EUR ECB President Lagarde Speaks']) {
      expect(titles).toContain(kept);
    }
  });

  it('skips a local-midnight entry as possibly All Day/Tentative and reports its title', () => {
    // the real export with one entry moved to local midnight
    const moved = BODY.replace('"2026-11-02T22:30:00-05:00","impact":"High"', '"2026-11-02T00:00:00-05:00","impact":"High"');
    expect(moved).not.toBe(BODY);
    const w = parseForexFactoryWeek(moved, JSON_TYPE);
    expect(w.skipped.midnight).toBe(1);
    expect(w.midnightTitles).toHaveLength(1);
    expect(w.events).toHaveLength(111);
  });

  it('throws instead of guessing: blocked, empty, non-JSON, no offset, unknown impact', () => {
    expect(() => parseForexFactoryWeek(BODY, 'text/html; charset=UTF-8')).toThrow(/not JSON \(content type text\/html/);
    expect(() => parseForexFactoryWeek(BODY, null)).toThrow(/not JSON \(content type none\)/);
    expect(() => parseForexFactoryWeek('<!DOCTYPE html><title>Just a moment...</title>', JSON_TYPE)).toThrow(/not valid JSON/);
    expect(() => parseForexFactoryWeek('[]', JSON_TYPE)).toThrow(/export is empty/);
    expect(() => parseForexFactoryWeek('{}', JSON_TYPE)).toThrow(/not an array/);
    expect(() => parseForexFactoryWeek(BODY.replace('2026-11-02T22:30:00-05:00', '2026-11-02T22:30:00'), JSON_TYPE))
      .toThrow(/without a UTC offset/);
    expect(() => parseForexFactoryWeek(BODY.replace('"impact":"Low"', '"impact":"Critical"'), JSON_TYPE))
      .toThrow(/impact "Critical"/);
    expect(() => parseForexFactoryWeek('', JSON_TYPE)).toThrow(CalendarParseError);
  });
});
