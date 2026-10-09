import { alignToBarStart } from './timeframe';

const at = (iso: string) => Date.parse(iso) / 1000;

describe('alignToBarStart', () => {
  const tick = at('2026-10-09T13:47:31Z');

  it.each([
    ['1m', '2026-10-09T13:47:00Z'],
    ['5m', '2026-10-09T13:45:00Z'],
    ['15m', '2026-10-09T13:45:00Z'],
    ['1h', '2026-10-09T13:00:00Z'],
    ['4h', '2026-10-09T12:00:00Z'],
    ['1d', '2026-10-09T00:00:00Z'],
  ] as const)('%s bar starts at %s', (timeframe, expected) => {
    expect(alignToBarStart(tick, timeframe)).toBe(at(expected));
  });

  it('keeps a tick exactly on a boundary in that bar', () => {
    expect(alignToBarStart(at('2026-10-09T13:00:00Z'), '1h')).toBe(at('2026-10-09T13:00:00Z'));
  });
});
