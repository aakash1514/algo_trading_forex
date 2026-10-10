import { classifyStub, easterSunday, evaluateStubs, EXPECTED_STUBS, holidayDates, type Coverage } from './stubs';

const FULL: Coverage[] = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'XAU/USD']
  .map((pair) => ({ pair, firstDate: '2010-01-01', lastDate: '2022-12-30' }));

describe('D1 stub list', () => {
  it('names exactly 20 Sunday stubs: EUR/USD 6, GBP/USD 4, USD/JPY 10, all FX 2013-2015, 1 minute', () => {
    const sundays = EXPECTED_STUBS.filter((s) => s.kind === 'sunday');
    expect(sundays).toHaveLength(20);
    const per = (pair: string) => sundays.filter((s) => s.pair === pair).length;
    expect([per('EUR/USD'), per('GBP/USD'), per('USD/JPY'), per('XAU/USD')]).toEqual([6, 4, 10, 0]);
    expect(sundays.every((s) => s.minutes === 1 && s.nyStart >= '2013' && s.nyStart < '2016')).toBe(true);
  });

  it('names exactly the 5 holiday stubs', () => {
    expect(EXPECTED_STUBS.filter((s) => s.kind === 'holiday').map((s) => `${s.pair} ${s.nyStart} ${s.minutes}`)).toEqual([
      'XAU/USD 2012-01-01 17:00 1',
      'EUR/USD 2012-12-31 17:00 16',
      'GBP/USD 2012-12-31 17:00 8',
      'USD/JPY 2012-12-31 17:00 22',
      'XAU/USD 2012-12-31 17:00 26',
    ]);
  });

  it('classifies every named stub as its kind', () => {
    for (const stub of EXPECTED_STUBS) expect(classifyStub(stub.nyStart)).toBe(stub.kind);
  });
});

describe('holiday calendar', () => {
  it.each([[2010, '2010-04-04'], [2012, '2012-04-08'], [2013, '2013-03-31'], [2019, '2019-04-21'], [2022, '2022-04-17']])(
    'Easter %i is %s', (year, date) => expect(easterSunday(year)).toBe(date));

  it('lists New Year, Good Friday, Easter Monday and Christmas trading days', () => {
    expect(holidayDates(2022)).toEqual(['2022-01-01', '2022-01-02', '2022-04-15', '2022-04-18',
      '2022-12-24', '2022-12-25', '2022-12-26', '2022-12-31']);
  });

  it.each([
    ['2013-03-28 17:00', 'holiday'], // session Good Friday 2013-03-29
    ['2013-03-31 17:00', 'holiday'], // session Easter Monday 2013-04-01
    ['2012-12-23 17:00', 'holiday'], // session Dec 24
    ['2013-01-19 17:00', 'sunday'],  // session Sunday 2013-01-20
  ])('classifies a bar starting %s as %s', (nyStart, kind) => {
    expect(classifyStub(nyStart)).toBe(kind);
  });

  // ordinary weekday, July 4 (not on the list), a Saturday session, a bar not at 17:00
  it.each(['2013-03-12 17:00', '2014-07-03 17:00', '2016-01-01 17:00', '2013-01-19 16:00'])('allows no stub at %s', (nyStart) => {
    expect(classifyStub(nyStart)).toBeNull();
  });
});

describe('evaluateStubs', () => {
  const found = EXPECTED_STUBS.map(({ pair, nyStart, minutes }) => ({ pair, nyStart, minutes }));

  it('passes on exactly the named stubs over the full import', () => {
    expect(evaluateStubs(found, FULL).ok).toBe(true);
  });

  it('fails on any other stub, even one of an allowed kind', () => {
    const result = evaluateStubs([...found, { pair: 'EUR/USD', nyStart: '2016-03-12 17:00', minutes: 1 }], FULL);
    expect(result.ok).toBe(false);
    expect(result.lines).toContain('  UNEXPECTED sunday: EUR/USD D1 starting 2016-03-12 17:00 NY, 1 min');
  });

  it('fails when a named stub is missing or has different minutes', () => {
    const changed = found.map((s) => (s.pair === 'EUR/USD' && s.nyStart === '2012-12-31 17:00' ? { ...s, minutes: 15 } : s));
    const result = evaluateStubs(changed, FULL);
    expect(result.ok).toBe(false);
    expect(result.lines).toContain('  MISSING holiday: EUR/USD D1 starting 2012-12-31 17:00 NY, 16 min');
  });

  it('requires only the named stubs inside the imported periods', () => {
    const partial: Coverage[] = [{ pair: 'EUR/USD', firstDate: '2012-12-31', lastDate: '2012-12-31' }];
    expect(evaluateStubs([{ pair: 'EUR/USD', nyStart: '2012-12-31 17:00', minutes: 16 }], partial).ok).toBe(true);
    expect(evaluateStubs([], partial).ok).toBe(false);
    expect(evaluateStubs([], []).ok).toBe(true);
  });
});
