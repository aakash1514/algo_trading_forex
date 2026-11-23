/** @jest-environment ./test/jsdom-with-fetch.cjs */
import { readdirSync } from 'fs';
import { join } from 'path';
import { act, fireEvent, screen, within } from '@testing-library/react';
import type { CalendarEvent, CalendarMessage, ReplayState } from '../../types/replay.types';
import { mockChart } from './__harness__/mocks';
import { fixture, openScreen, page, setupReplayPage } from './__harness__/page';
import { calendarMarkers, shownCalendarEvents } from './ReplayCalendar';

// Calendar events on the replay chart, through the real page and store with recorded
// replay-service payloads: the EUR/USD session at 2022-03-16 17:58 (state-calendar-before),
// the step that reached the FOMC decision at 18:00 (calendar-fomc), the reconnect after
// it (state-calendar-after), and USD/JPY in 2016, before the stored calendar begins.

jest.mock('lightweight-charts', () => jest.requireActual('./__harness__/mocks').chartLibrary);
jest.mock('socket.io-client', () => ({ io: () => jest.requireActual('./__harness__/mocks').sockets.current }));

setupReplayPage();

const BEFORE = fixture<ReplayState>('state-calendar-before');
const MESSAGE = fixture<CalendarMessage>('calendar-fomc');
const FOMC = MESSAGE.events[0];
const seconds = (iso: string) => Date.parse(iso) / 1000;
const lastMarkers = () => mockChart.markers.at(-1);
const hover = (time: number) => act(() => mockChart.crosshair?.({ time, point: { x: 40, y: 60 } }));

describe('replay calendar: no look-ahead in what replay-service sent', () => {
  it('no recorded state or calendar message holds an event after its clock', () => {
    const dir = join(__dirname, '__fixtures__');
    let checked = 0;
    for (const file of readdirSync(dir).filter((f) => f.startsWith('state-') || f.startsWith('calendar-'))) {
      const payload = fixture<Partial<ReplayState> & Partial<CalendarMessage>>(file.replace('.json', ''));
      const clock = payload.session?.clockTime ?? payload.clockTime;
      const events = payload.calendar?.events ?? payload.events ?? [];
      for (const e of events) {
        expect(e.time <= (clock as string)).toBe(true);
        expect(e.barTime <= e.time).toBe(true);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('two minutes before the decision the state has none of it', () => {
    expect(BEFORE.session.clockTime).toBe('2022-03-16T17:58:00.000Z');
    expect(FOMC.time).toBe('2022-03-16T18:00:00.000Z');
    expect(BEFORE.calendar).toEqual({ covered: true, events: [] });
  });
});

describe('replay calendar: markers', () => {
  it('no marker before the decision; the step that reaches it adds one on its bar, without reloading the chart', async () => {
    await openScreen(BEFORE);
    expect(lastMarkers()).toEqual([]);
    expect(screen.getByTestId('replay-calendar-count').textContent).toBe('0 events on the chart');
    const loads = mockChart.setData.length;

    page.socket.serve('calendar', MESSAGE);
    expect(lastMarkers()).toEqual([expect.objectContaining({ time: seconds(FOMC.barTime), text: 'USD', color: '#ef4444' })]);
    expect(screen.getByTestId('replay-calendar-count').textContent).toBe('1 event on the chart');
    expect(mockChart.setData).toHaveLength(loads);

    page.socket.serve('calendar', fixture('calendar-fomc')); // the same event again: still one
    expect(lastMarkers()).toHaveLength(1);
    page.socket.serve('calendar', { ...fixture<CalendarMessage>('calendar-fomc'), timeframe: '1h' }); // the old timeframe
    expect(lastMarkers()).toHaveLength(1);
  });

  it('a state that has reached the decision draws it at once', async () => {
    await openScreen(fixture('state-calendar-after'));
    expect(lastMarkers()).toEqual([expect.objectContaining({ time: seconds(FOMC.barTime), text: 'USD' })]);
  });

  it('hovering the bar shows the event: title, currency, impact, source, time; no actual/forecast/previous stored', async () => {
    await openScreen(fixture('state-calendar-after'));
    hover(seconds(FOMC.barTime));
    const card = screen.getByTestId('replay-calendar-card');
    const lines = within(card).getAllByText(/./).map((n) => n.textContent);
    expect(lines).toEqual(expect.arrayContaining([
      'FOMC meeting, March 15-16, with Summary of Economic Projections',
      'Wed 16 Mar 2022 18:00 UTC (expected)',
    ]));
    expect(card.textContent).toContain('USD · High impact · FOMC');
    expect(card.textContent).not.toMatch(/Actual|Forecast|Previous/);
    hover(seconds(FOMC.barTime) - 60); // the bar before: nothing there
    expect(screen.queryByTestId('replay-calendar-card')).toBeNull();
  });

  it('before the stored calendar begins: "No calendar data for this period"', async () => {
    const usdjpy = fixture<ReplayState>('state-usdjpy-open-positions');
    expect(usdjpy.session.clockTime < '2021-01-01').toBe(true);
    expect(usdjpy.calendar.covered).toBe(false);
    await openScreen(usdjpy);
    expect(screen.getByTestId('replay-calendar-empty').textContent).toBe('No calendar data for this period');
    expect(lastMarkers()).toEqual([]);
  });

  it('the Medium impact toggle is off by default and only changes what is drawn', async () => {
    await openScreen(fixture('state-calendar-after'));
    const toggle = screen.getByTestId('replay-calendar-medium') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(true);
    expect(lastMarkers()).toHaveLength(1); // the only stored events in the history are HIGH (FOMC)
    expect(page.socket.sent).toEqual([]);
  });
});

describe('replay calendar: impact filter', () => {
  // The recorded event, and the same event with only its impact changed (no stored MEDIUM
  // event falls inside the replay history)
  const medium: CalendarEvent = { ...FOMC, id: `${FOMC.id}-medium`, impact: 'MEDIUM' };

  it('HIGH only by default; the toggle adds MEDIUM', () => {
    expect(shownCalendarEvents([FOMC, medium], false)).toEqual([FOMC]);
    expect(shownCalendarEvents([FOMC, medium], true)).toEqual([FOMC, medium]);
  });

  it('a MEDIUM marker is amber, a HIGH one red', () => {
    expect(calendarMarkers([FOMC, medium]).map((m) => m.color)).toEqual(['#ef4444', '#f59e0b']);
  });
});
