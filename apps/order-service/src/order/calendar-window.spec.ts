import { CALENDAR_WARNING_WINDOW_MS, calendarWarningWindow } from './calendar-window';

// The FOMC decision of 18 Mar 2026 at its expected time, 14:00 New York = 18:00 UTC (EDT since 8 Mar).
const EVENT = new Date('2026-03-18T18:00:00.000Z');

// The order time at an offset from the event, e.g. '-30:01' = 30 min 1 s before it
function at(offset: string): Date {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  if (!m) throw new Error(`bad offset ${offset}`);
  const seconds = Number(m[2]) * 60 + Number(m[3]);
  return new Date(EVENT.getTime() + (m[1] === '-' ? -1 : 1) * seconds * 1000);
}

// The query's BETWEEN, inclusive at both ends
function warns(orderAt: Date): boolean {
  const { windowStart, windowEnd } = calendarWarningWindow(orderAt);
  return EVENT >= windowStart && EVENT <= windowEnd;
}

describe('calendarWarningWindow (gate 5)', () => {
  it('is 30 minutes either side of the order', () => {
    expect(CALENDAR_WARNING_WINDOW_MS).toBe(1_800_000);
    expect(calendarWarningWindow(EVENT)).toEqual({
      windowStart: new Date('2026-03-18T17:30:00.000Z'),
      windowEnd: new Date('2026-03-18T18:30:00.000Z'),
    });
  });

  it('warns from 30:00 before to 30:00 after the event, both inclusive', () => {
    expect(warns(at('-30:00'))).toBe(true);
    expect(warns(at('-30:01'))).toBe(false);
    expect(warns(at('+30:00'))).toBe(true);
    expect(warns(at('+30:01'))).toBe(false);
    expect(warns(EVENT)).toBe(true);
  });

  it('rejects an invalid order time instead of matching nothing', () => {
    expect(() => calendarWarningWindow(new Date(Number.NaN))).toThrow('Invalid order time');
  });
});
