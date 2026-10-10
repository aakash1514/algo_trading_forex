import { newYorkWindow, utcWindows } from './aggregates';
import { yearRange } from './pairs';

const d = (iso: string) => new Date(iso);

describe('refresh windows', () => {
  it('keeps consecutive years as separate UTC windows', () => {
    expect(utcWindows([yearRange(2012), yearRange(2013)])).toEqual([yearRange(2012), yearRange(2013)]);
  });

  it('widens UTC windows to whole days and merges overlaps', () => {
    expect(utcWindows([
      { start: d('2013-01-01T00:00Z'), end: d('2013-01-02T12:00Z') },
      { start: d('2012-12-31T12:00Z'), end: d('2013-01-01T00:00Z') },
      { start: d('2013-01-02T06:00Z'), end: d('2013-01-03T00:00Z') },
    ])).toEqual([
      { start: d('2012-12-31T00:00Z'), end: d('2013-01-01T00:00Z') },
      { start: d('2013-01-01T00:00Z'), end: d('2013-01-03T00:00Z') },
    ]);
  });

  // The NY bar holding the evening of Dec 31 starts 22:00 UTC and ends the next
  // day: it must lie fully inside the window, which yearly windows never allow.
  it('spans every range in one New York window padded a week each side', () => {
    const window = newYorkWindow([yearRange(2013), yearRange(2012), yearRange(2015)]);
    expect(window).toEqual({ start: d('2011-12-25T00:00Z'), end: d('2016-01-08T00:00Z') });
    const boundaryBar = { start: d('2012-12-31T22:00Z'), end: d('2013-01-01T22:00Z') };
    expect(boundaryBar.start >= window.start && boundaryBar.end <= window.end).toBe(true);
  });
});
