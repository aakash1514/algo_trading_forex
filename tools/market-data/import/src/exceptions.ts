// Investigated exceptions to the FRED spot check (step 2.4). Validation passes only
// when exactly these days fail, each with exactly this deviation, and when the one
// median exception is exactly as recorded. Evidence for each: the "Investigated
// exceptions" section of docs/validation/historical-spot-checks.md.
//
// Common to every listed day: the fixing lies inside our range for that New York
// day, and our 11:45-12:15 NY bars are all present with normal spreads (0.1-2 pips)
// and no spike, so the fixing, not our data, is off noon. "Matches" gives the NY
// times at which our mid came closest to the fixing.

export interface DayException {
  pair: string;
  date: string;
  pips: string; // our mid - fixing, 2 dp, as computed
  reason: string;
}

export interface MedianException {
  pair: string;
  year: number;
  medianPips: string; // 2 dp, as computed
  reason: string;
}

const day = (pair: string, date: string, pips: string, reason: string): DayException => ({ pair, date, pips, reason });

export const DAY_EXCEPTIONS: readonly DayException[] = [
  day('EUR/USD', '2010-01-26', '21.50', 'fixing matches our prices at 09:21-10:02 NY, not noon'),
  day('GBP/USD', '2010-01-26', '52.25', 'fixing matches our prices at 05:38-09:04 NY, not noon'),
  day('GBP/USD', '2010-01-28', '-96.75', 'fixing matches our prices at 06:46-09:47 NY, not noon'),
  day('USD/JPY', '2010-01-28', '-29.75', 'fixing matches our prices at 09:40-10:22 NY, not noon'),
  day('GBP/USD', '2010-04-13', '-46.25', 'fixing matches our prices at 09:55 and 20:55 NY, not noon'),
  day('USD/JPY', '2010-04-13', '39.00', 'fixing matches our prices at 01:45-08:49 NY, not noon'),
  day('EUR/USD', '2010-06-23', '-83.80', 'FOMC day (statement 14:15 ET); fixing matches our prices only at 16:36-16:47 NY'),
  day('GBP/USD', '2010-06-23', '-66.00', 'FOMC day (statement 14:15 ET); fixing matches our prices only at 15:54-16:30 NY'),
  day('USD/JPY', '2010-06-23', '28.50', 'FOMC day (statement 14:15 ET); fixing matches our prices only at 15:03-17:03 NY'),
  day('EUR/USD', '2010-06-24', '73.40', 'fixing matches our prices at 04:22-06:24 NY; EUR/USD moved 54 pips in 11:45-12:15'),
  day('EUR/USD', '2010-07-08', '-25.00', 'fixing matches our prices at 22:20-22:36 NY, not noon'),
  day('GBP/USD', '2010-07-08', '-43.50', 'fixing matches our prices at 05:13-08:04 NY, not noon'),
  day('EUR/USD', '2012-02-01', '24.25', 'fixing matches our prices at 10:24-10:48 NY, not noon'),
  day('EUR/USD', '2013-09-23', '-27.55', 'fixing matches our prices at 03:43-05:14 NY, not noon'),
  day('GBP/USD', '2013-09-23', '-28.70', 'fixing matches our prices at 08:46-08:50 NY, not noon'),
  day('EUR/USD', '2017-06-27', '26.80', 'fast market (Draghi, Sintra); fixing matches our prices at 11:17-11:54 NY, 40-pip move in 11:45-12:15'),
  day('USD/JPY', '2022-06-03', '23.85', 'fast market (US payrolls); fixing matches our prices at 10:52-10:59 NY'),
];

export const MEDIAN_EXCEPTIONS: readonly MedianException[] = [
  { pair: 'EUR/USD', year: 2010, medianPips: '1.60',
    reason: '2010\'s wider spreads: median 1.60 pips vs the 1.5 limit (p95 4.25 stays within 5)' },
];

export interface Exceptions {
  days: readonly DayException[];
  medians: readonly MedianException[];
}

export const EXCEPTIONS: Exceptions = { days: DAY_EXCEPTIONS, medians: MEDIAN_EXCEPTIONS };

export interface ExceptionOutcome {
  problems: string[];
  exceptedDays: (DayException & { fixing: string; mid: string })[];
  medianExcepted: MedianException | null;
}

// Checks one pair-year's failures against the named exceptions. Only exceptions
// of this pair-year are required, so partial comparisons check their share.
export function applyExceptions(
  pair: string,
  year: number,
  failing: { date: string; fixing: string; mid: string; pips: number }[],
  median: number | null,
  maxMedian: number,
  exceptions: Exceptions = EXCEPTIONS,
): ExceptionOutcome {
  const problems: string[] = [];
  const expected = exceptions.days.filter((e) => e.pair === pair && e.date.startsWith(`${year}-`));
  const exceptedDays: ExceptionOutcome['exceptedDays'] = [];
  for (const f of failing) {
    const e = expected.find((x) => x.date === f.date);
    if (!e) problems.push(`${f.date}: ${f.pips.toFixed(2)} pips (not an investigated exception)`);
    else if (e.pips !== f.pips.toFixed(2)) problems.push(`${f.date}: ${f.pips.toFixed(2)} pips, exception recorded ${e.pips}`);
    else exceptedDays.push({ ...e, fixing: f.fixing, mid: f.mid });
  }
  for (const e of expected) {
    if (!failing.some((f) => f.date === e.date)) problems.push(`exception ${e.date} (${e.pips} pips) no longer fails`);
  }

  let medianExcepted: MedianException | null = null;
  const me = exceptions.medians.find((m) => m.pair === pair && m.year === year);
  const over = median !== null && median > maxMedian;
  if (me) {
    if (median === null || median.toFixed(2) !== me.medianPips) {
      problems.push(`median ${median === null ? '-' : median.toFixed(2)}, exception recorded ${me.medianPips}`);
    } else if (!over) {
      problems.push(`median exception (${me.medianPips}) no longer exceeds ${maxMedian}`);
    } else {
      medianExcepted = me;
    }
  } else if (over) {
    problems.push(`median above ${maxMedian} pips`);
  }
  return { problems, exceptedDays, medianExcepted };
}
