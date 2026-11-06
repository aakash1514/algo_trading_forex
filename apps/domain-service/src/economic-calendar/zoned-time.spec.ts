import { zonedToUtc } from './zoned-time';
import { CalendarParseError } from './official-sources';

describe('zonedToUtc (IANA zones, DST from the time zone database)', () => {
  it('New York: EST is UTC-5, EDT is UTC-4', () => {
    expect(zonedToUtc('2026-01-28', '14:00', 'America/New_York').toISOString()).toBe('2026-01-28T19:00:00.000Z');
    expect(zonedToUtc('2026-03-18', '14:00', 'America/New_York').toISOString()).toBe('2026-03-18T18:00:00.000Z');
    expect(zonedToUtc('2026-11-02', '08:30', 'America/New_York').toISOString()).toBe('2026-11-02T13:30:00.000Z');
  });

  it('Frankfurt: CET is UTC+1, CEST is UTC+2, and the EU switches on different days from the US', () => {
    expect(zonedToUtc('2026-03-18', '14:15', 'Europe/Berlin').toISOString()).toBe('2026-03-18T13:15:00.000Z');
    expect(zonedToUtc('2026-07-23', '14:15', 'Europe/Berlin').toISOString()).toBe('2026-07-23T12:15:00.000Z');
    // 2026-10-29: after the EU switch (25 Oct), before the US switch (1 Nov)
    expect(zonedToUtc('2026-10-29', '14:15', 'Europe/Berlin').toISOString()).toBe('2026-10-29T13:15:00.000Z');
    expect(zonedToUtc('2026-10-29', '14:00', 'America/New_York').toISOString()).toBe('2026-10-29T18:00:00.000Z');
  });

  it('throws on a local time skipped or repeated by a DST change, instead of guessing', () => {
    expect(() => zonedToUtc('2026-03-08', '02:30', 'America/New_York')).toThrow(/does not exist/);
    expect(() => zonedToUtc('2026-11-01', '01:30', 'America/New_York')).toThrow(/ambiguous/);
    expect(() => zonedToUtc('2026-03-29', '02:30', 'Europe/Berlin')).toThrow(/does not exist/);
  });

  it('throws on malformed or impossible input', () => {
    expect(() => zonedToUtc('', '', 'America/New_York')).toThrow(CalendarParseError);
    expect(() => zonedToUtc('2026-02-30', '14:00', 'America/New_York')).toThrow(CalendarParseError);
    expect(() => zonedToUtc('2026-02-10', '24:00', 'America/New_York')).toThrow(CalendarParseError);
    expect(() => zonedToUtc('2026-02-10', '14:00', 'Not/AZone')).toThrow(RangeError);
  });
});
