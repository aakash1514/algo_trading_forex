import { applyExceptions, DAY_EXCEPTIONS, MEDIAN_EXCEPTIONS } from './exceptions';

const fail = (date: string, pips: number) => ({ date, fixing: '1', mid: '1', pips });

describe('FRED spot-check exceptions', () => {
  it('names the 17 investigated days and one median exception', () => {
    expect(DAY_EXCEPTIONS).toHaveLength(17);
    expect(new Set(DAY_EXCEPTIONS.map((e) => `${e.pair} ${e.date}`)).size).toBe(17);
    expect(MEDIAN_EXCEPTIONS.map((m) => `${m.pair} ${m.year} ${m.medianPips}`)).toEqual(['EUR/USD 2010 1.60']);
  });

  it('passes when exactly the named days fail with the recorded deviation', () => {
    const out = applyExceptions('USD/JPY', 2010, [fail('2010-01-28', -29.75), fail('2010-04-13', 39), fail('2010-06-23', 28.5)],
      0.75, 1.5);
    expect(out.problems).toEqual([]);
    expect(out.exceptedDays).toHaveLength(3);
  });

  it('fails on an unlisted day, a changed deviation, or a listed day that no longer fails', () => {
    expect(applyExceptions('USD/JPY', 2022, [fail('2022-06-03', 23.85), fail('2022-06-10', 21)], 0.8, 1.5).problems)
      .toEqual(['2022-06-10: 21.00 pips (not an investigated exception)']);
    expect(applyExceptions('USD/JPY', 2022, [fail('2022-06-03', 23.9)], 0.8, 1.5).problems)
      .toEqual(['2022-06-03: 23.90 pips, exception recorded 23.85']);
    expect(applyExceptions('USD/JPY', 2022, [], 0.8, 1.5).problems)
      .toEqual(['exception 2022-06-03 (23.85 pips) no longer fails']);
  });

  it('accepts the EUR/USD 2010 median only exactly as recorded', () => {
    const days2010 = DAY_EXCEPTIONS.filter((e) => e.pair === 'EUR/USD' && e.date.startsWith('2010'))
      .map((e) => fail(e.date, Number(e.pips)));
    const at = (median: number) => applyExceptions('EUR/USD', 2010, days2010, median, 1.5);
    expect(at(1.6).problems).toEqual([]);
    expect(at(1.6).medianExcepted?.year).toBe(2010);
    expect(at(1.65).problems).toEqual(['median 1.65, exception recorded 1.60']);
    expect(applyExceptions('EUR/USD', 2011, [], 1.6, 1.5).problems).toEqual(['median above 1.5 pips']);
  });
});
