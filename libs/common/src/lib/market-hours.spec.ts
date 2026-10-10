import { activeSessions, marketStatus, sessionLabel } from './market-hours';

const t = (iso: string) => new Date(iso);

// 2026 clock changes: US DST Mar 8 - Nov 1, UK BST Mar 29 - Oct 25.
describe('marketStatus', () => {
  describe('FX', () => {
    it.each([
      // [utc instant, open?, reason, reopens at]
      ['2026-10-09T20:59:00Z', true, undefined, undefined],                                        // Fri 16:59 EDT
      ['2026-10-09T21:00:00Z', false, 'WEEKEND', '2026-10-11T21:00:00.000Z'], // Fri 17:00 EDT
      ['2026-10-10T12:00:00Z', false, 'WEEKEND', '2026-10-11T21:00:00.000Z'], // Saturday
      ['2026-10-11T20:59:00Z', false, 'WEEKEND', '2026-10-11T21:00:00.000Z'], // Sun 16:59 EDT
      ['2026-10-11T21:00:00Z', true, undefined, undefined],                                        // Sun 17:00 EDT
      ['2026-01-09T21:59:00Z', true, undefined, undefined],                                        // Fri 16:59 EST
      ['2026-01-09T22:00:00Z', false, 'WEEKEND', '2026-01-11T22:00:00.000Z'], // Fri 17:00 EST
      ['2026-01-11T22:00:00Z', true, undefined, undefined],                                        // Sun 17:00 EST
      // DST starts Sunday Mar 8: Friday closes on EST, Sunday opens on EDT
      ['2026-03-06T22:00:00Z', false, 'WEEKEND', '2026-03-08T21:00:00.000Z'],
      ['2026-03-08T20:59:00Z', false, 'WEEKEND', '2026-03-08T21:00:00.000Z'],
      ['2026-03-08T21:00:00Z', true, undefined, undefined],
      // DST ends Sunday Nov 1: Friday closes on EDT, Sunday opens on EST
      ['2026-10-30T21:00:00Z', false, 'WEEKEND', '2026-11-01T22:00:00.000Z'],
      ['2026-11-01T21:59:00Z', false, 'WEEKEND', '2026-11-01T22:00:00.000Z'],
      ['2026-11-01T22:00:00Z', true, undefined, undefined],
      // Weekday 17:00-18:00 NY is open for FX
      ['2026-10-12T21:30:00Z', true, undefined, undefined],
    ])('%s -> open=%s %s', (iso, open, reason, reopensAt) => {
      const status = marketStatus('MAJOR', t(iso));
      expect(status.open).toBe(open);
      expect(status.reason).toBe(reason);
      expect(status.reopensAt?.toISOString()).toBe(reopensAt);
    });

    it('treats MINOR and EXOTIC like MAJOR', () => {
      expect(marketStatus('MINOR', t('2026-10-12T21:30:00Z')).open).toBe(true);
      expect(marketStatus('EXOTIC', t('2026-10-10T12:00:00Z')).reason).toBe('WEEKEND');
    });
  });

  describe('metals (XAU/USD)', () => {
    it.each([
      ['2026-10-11T21:00:00Z', false, 'WEEKEND', '2026-10-11T22:00:00.000Z'],     // Sun 17:00 EDT: gold not yet
      ['2026-10-11T21:59:00Z', false, 'WEEKEND', '2026-10-11T22:00:00.000Z'],
      ['2026-10-11T22:00:00Z', true, undefined, undefined],                                            // Sun 18:00 EDT
      ['2026-10-12T20:59:00Z', true, undefined, undefined],                                            // Mon 16:59 EDT
      ['2026-10-12T21:00:00Z', false, 'DAILY_BREAK', '2026-10-12T22:00:00.000Z'], // Mon 17:00 EDT
      ['2026-10-12T21:59:00Z', false, 'DAILY_BREAK', '2026-10-12T22:00:00.000Z'],
      ['2026-10-12T22:00:00Z', true, undefined, undefined],                                            // Mon 18:00 EDT
      ['2026-10-15T21:30:00Z', false, 'DAILY_BREAK', '2026-10-15T22:00:00.000Z'], // Thursday
      ['2026-10-16T21:00:00Z', false, 'WEEKEND', '2026-10-18T22:00:00.000Z'],     // Friday close is the weekend
      ['2026-01-12T22:30:00Z', false, 'DAILY_BREAK', '2026-01-12T23:00:00.000Z'], // winter: 17:30 EST
      ['2026-01-11T22:30:00Z', false, 'WEEKEND', '2026-01-11T23:00:00.000Z'],     // winter Sunday 17:30 EST
      ['2026-01-11T23:00:00Z', true, undefined, undefined],
    ])('%s -> open=%s %s', (iso, open, reason, reopensAt) => {
      const status = marketStatus('METAL', t(iso));
      expect(status.open).toBe(open);
      expect(status.reason).toBe(reason);
      expect(status.reopensAt?.toISOString()).toBe(reopensAt);
    });
  });
});

describe('activeSessions', () => {
  it.each([
    // Wednesday Oct 7 2026: BST (London 07-15 UTC) and EDT (New York 12-21 UTC)
    ['2026-10-07T01:00:00Z', ['SYDNEY', 'TOKYO']],
    ['2026-10-07T06:30:00Z', ['TOKYO']],
    ['2026-10-07T07:00:00Z', ['TOKYO', 'LONDON']],
    ['2026-10-07T09:00:00Z', ['LONDON']],
    ['2026-10-07T12:00:00Z', ['LONDON', 'NEW_YORK']],
    ['2026-10-07T15:00:00Z', ['NEW_YORK']],
    ['2026-10-07T21:00:00Z', ['SYDNEY']],
    // Wednesday Jan 14 2026: GMT (London 08-16) and EST (New York 13-22)
    ['2026-01-14T07:30:00Z', ['TOKYO']],
    ['2026-01-14T08:00:00Z', ['TOKYO', 'LONDON']],
    ['2026-01-14T13:00:00Z', ['LONDON', 'NEW_YORK']],
    ['2026-01-14T21:30:00Z', ['SYDNEY', 'NEW_YORK']],
    ['2026-01-14T22:00:00Z', ['SYDNEY']],
    // Weekend: no sessions, although the old clock reported them
    ['2026-10-10T10:00:00Z', []], // Saturday, London hours
    ['2026-10-09T21:00:00Z', []], // Friday 17:00 EDT
    ['2026-01-11T21:30:00Z', []], // Sunday 16:30 EST
    ['2026-01-11T22:00:00Z', ['SYDNEY']], // Sunday 17:00 EST: the week opens with Sydney
  ])('%s -> %j', (iso, sessions) => {
    expect(activeSessions(t(iso))).toEqual(sessions);
  });

  it('labels orders with the joined sessions, or OFF_HOURS', () => {
    expect(sessionLabel(t('2026-10-07T12:00:00Z'))).toBe('LONDON,NEW_YORK');
    expect(sessionLabel(t('2026-10-10T10:00:00Z'))).toBe('OFF_HOURS');
  });
});
