import {
  adjacentSpeed, centsToDecimal, decimalToCents, decimalToPoints, endSummary, formatReplayTime, formatUsd, PAUSE_MESSAGES,
  replayErrorMessage, startingBalanceFromInput, startTimeFromInputs, statusMessage, validateOrder,
} from './replay';
import { PAUSE_REASONS, type ReplayPosition, type ReplaySession } from '../types/replay.types';

describe('replay start inputs', () => {
  it.each([
    ['2010-01-01', '00:00', '2010-01-01T00:00Z'],
    ['2022-12-30', '23:59', '2022-12-30T23:59Z'],
    ['2016-02-29', '12:30', '2016-02-29T12:30Z'],
  ])('accepts %s %s as %s', (date, time, expected) => {
    expect(startTimeFromInputs(date, time)).toEqual({ ok: true, value: expected });
  });

  it.each([
    ['2009-12-31', '23:59', 'between'],
    ['2022-12-31', '00:00', 'between'],
    ['2022-02-30', '10:00', 'not a real date'],
    ['2022-01-03', '24:00', 'not a real date'],
    ['', '10:00', 'Enter a date'],
    ['2022-01-03', '', 'Enter a date'],
  ])('refuses %s %s', (date, time, message) => {
    const r = startTimeFromInputs(date, time);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain(message);
  });

  it('takes a balance of $100 to $10,000,000 with at most 2 decimals', () => {
    expect(startingBalanceFromInput('10000')).toEqual({ ok: true, value: 10000 });
    expect(startingBalanceFromInput('100')).toEqual({ ok: true, value: 100 });
    expect(startingBalanceFromInput('10000000.00')).toEqual({ ok: true, value: 10_000_000 });
    for (const bad of ['99.99', '10000000.01', '1.234', '', 'abc', '-500']) expect(startingBalanceFromInput(bad).ok).toBe(false);
  });
});

describe('replay speeds', () => {
  it('faster is the next shorter time per bar, slower the next longer one, from the middle', () => {
    expect(adjacentSpeed(1000, 'faster')).toBe(500);
    expect(adjacentSpeed(1000, 'slower')).toBe(2000);
  });

  it('stops at both ends (no wrap), and has no neighbour for a speed it does not offer', () => {
    expect(adjacentSpeed(500, 'faster')).toBeNull();
    expect(adjacentSpeed(500, 'slower')).toBe(1000);
    expect(adjacentSpeed(2000, 'slower')).toBeNull();
    expect(adjacentSpeed(2000, 'faster')).toBe(1000);
    expect(adjacentSpeed(750, 'faster')).toBeNull();
  });
});

describe('replay status line', () => {
  it('has a message for every pause reason', () => {
    expect(PAUSE_REASONS.length).toBe(5);
    expect(Object.keys(PAUSE_MESSAGES).sort()).toEqual([...PAUSE_REASONS].sort());
    expect(PAUSE_MESSAGES).toEqual({
      USER: 'Paused',
      OTHER_TAB: 'Paused: replay opened in another tab or window',
      DISCONNECT: 'Paused: connection lost',
      SERVER_RESTART: 'Paused: server restarted',
      END_OF_DATA: 'End of historical data (30 Dec 2022)',
    });
  });

  it.each(PAUSE_REASONS.map((r) => [r]))('a session paused for %s shows its message', (reason) => {
    expect(statusMessage({ status: 'PAUSED', pauseReason: reason, endOfData: reason === 'END_OF_DATA' }))
      .toBe(PAUSE_MESSAGES[reason]);
  });

  it('playing, paused with no reason, and the end of the data whatever the reason', () => {
    expect(statusMessage({ status: 'PLAYING', pauseReason: null, endOfData: false })).toBe('Playing');
    expect(statusMessage({ status: 'PAUSED', pauseReason: null, endOfData: false })).toBe('Paused');
    expect(statusMessage({ status: 'PAUSED', pauseReason: 'OTHER_TAB', endOfData: true })).toBe(PAUSE_MESSAGES.END_OF_DATA);
  });
});

describe('exact decimals', () => {
  it('turns prices into points at the pair scale without floats', () => {
    expect(decimalToPoints('1.12186', 5)).toBe(112186);
    expect(decimalToPoints('1.1', 5)).toBe(110000);
    expect(decimalToPoints('151.234', 3)).toBe(151234);
    expect(decimalToPoints('1.121861', 5)).toBeNull();
    expect(decimalToPoints('abc', 5)).toBeNull();
  });

  it('formats USD from the decimal strings', () => {
    expect(formatUsd('10000.00')).toBe('$10,000.00');
    expect(formatUsd('-11.70')).toBe('-$11.70');
    expect(formatUsd('0.00', true)).toBe('+$0.00');
    expect(formatUsd('1485.75', true)).toBe('+$1,485.75');
    expect(formatUsd('-1234567.5')).toBe('-$1,234,567.50');
    expect(centsToDecimal(decimalToCents('9988.30') - decimalToCents('10000.00'))).toBe('-11.70');
  });

  it('shows the replay clock in UTC', () => {
    expect(formatReplayTime('2015-03-14T10:32:00.000Z')).toBe('2015-03-14 10:32 UTC');
  });
});

describe('order checks before sending', () => {
  const quote = { bid: '1.12032', ask: '1.12035', decimals: 5 };
  const order = (over: Partial<Parameters<typeof validateOrder>[0]>) =>
    validateOrder({ side: 'BUY', lots: '0.1', stopLoss: '', takeProfit: '', ...over }, quote);

  it('a long: SL below the bid, TP above it', () => {
    expect(order({ stopLoss: '1.11932', takeProfit: '1.12132' }))
      .toEqual({ ok: true, value: { side: 'BUY', lots: 0.1, stopLoss: 1.11932, takeProfit: 1.12132 } });
    expect(order({ stopLoss: '1.12032' })).toEqual({ ok: false, error: 'Stop loss must be below the bid 1.12032' });
    expect(order({ takeProfit: '1.12032' })).toEqual({ ok: false, error: 'Take profit must be above the bid 1.12032' });
  });

  it('a short: TP below the ask, SL above it', () => {
    expect(order({ side: 'SELL', stopLoss: '1.12135', takeProfit: '1.11935' }).ok).toBe(true);
    expect(order({ side: 'SELL', stopLoss: '1.12035' })).toEqual({ ok: false, error: 'Stop loss must be above the ask 1.12035' });
    expect(order({ side: 'SELL', takeProfit: '1.12036' })).toEqual({ ok: false, error: 'Take profit must be below the ask 1.12035' });
  });

  it('lots 0.01 to 100 with 2 decimals, levels in whole points', () => {
    expect(order({ lots: '0.01' }).ok).toBe(true);
    expect(order({ lots: '100' }).ok).toBe(true);
    for (const lots of ['0', '0.001', '100.01', '', 'x']) expect(order({ lots }).ok).toBe(false);
    expect(order({ stopLoss: '1.119321' })).toEqual({ ok: false, error: 'Stop loss must be a price with at most 5 decimals' });
  });
});

describe('server errors in plain words', () => {
  it('names the fields and passes the server sentences through', () => {
    expect(replayErrorMessage({ status: 400, data: { message: 'stopLoss 1.20000 must be below the bid 1.12032' } }))
      .toBe('Stop loss 1.20000 must be below the bid 1.12032');
    expect(replayErrorMessage({ status: 400, data: { message: ['lots must not be greater than 100'] } }))
      .toBe('Lots must not be greater than 100');
    expect(replayErrorMessage({ status: 'FETCH_ERROR' })).toContain('unreachable');
  });
});

describe('end summary', () => {
  const session = { startingBalance: '10000.00', balance: '9988.30' } as ReplaySession;
  const closed = (id: string) => ({ id }) as ReplayPosition;

  it('net P&L is final minus starting balance; trades are the distinct closed positions', () => {
    expect(endSummary(session, ['a', 'b'], [closed('b'), closed('c')], false))
      .toEqual({ startingBalance: '10000.00', finalBalance: '9988.30', netPnl: '-11.70', trades: 3, tradesCapped: false });
  });
});
