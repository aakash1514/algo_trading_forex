import { assertNothingAfterClock, FutureDataError } from './replay-emitter';

const clock = new Date('2022-01-03T09:59:00Z');

describe('assertNothingAfterClock', () => {
  it('passes market times at or before the clock, nested in objects and arrays', () => {
    expect(() => assertNothingAfterClock({
      clockTime: '2022-01-03T09:59:00.000Z',
      bars: [{ time: '2022-01-03T08:00:00.000Z', lastMinute: null }, { time: '2022-01-03T09:00:00.000Z' }],
      currentBar: { time: '2022-01-03T09:00:00.000Z', lastMinute: '2022-01-03T09:59:00.000Z' },
      positions: [{ placedAt: '2022-01-03T09:10:00.000Z', entryTime: '2022-01-03T09:11:00.000Z', exitTime: null }],
    }, clock)).not.toThrow();
  });

  it.each([
    ['a bar', { bars: [{ time: '2022-01-03T10:00:00.000Z' }] }, '$.bars[0].time'],
    ['the current bar', { currentBar: { time: '2022-01-03T09:00:00.000Z', lastMinute: '2022-01-03T10:00:00.000Z' } },
      '$.currentBar.lastMinute'],
    ['a fill', { positions: [{ entryTime: '2022-01-03T09:59:00.001Z' }] }, '$.positions[0].entryTime'],
    ['a clock', { clockTime: new Date('2022-01-03T10:01:00Z') }, '$.clockTime'],
  ])('refuses %s after the clock', (_case, payload, path) => {
    expect(() => assertNothingAfterClock(payload, clock)).toThrow(FutureDataError);
    expect(() => assertNothingAfterClock(payload, clock)).toThrow(path);
  });

  it('ignores wall-clock audit times and the chosen start time', () => {
    expect(() => assertNothingAfterClock({
      session: { createdAt: '2026-11-09T17:00:00Z', updatedAt: '2026-11-09T17:00:00Z', endedAt: null, startTime: '2022-12-30T23:59:00Z' },
      positions: [{ cancelledAt: '2026-11-09T17:00:00Z' }],
    }, clock)).not.toThrow();
  });

  it('refuses a market time it cannot read', () => {
    expect(() => assertNothingAfterClock({ time: 'soon' }, clock)).toThrow('is not a time');
  });
});
