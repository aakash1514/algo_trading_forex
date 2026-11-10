/** @jest-environment ./test/jsdom-with-fetch.cjs */
import { readFileSync } from 'fs';
import { join } from 'path';
import { render, screen, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { store } from '../../store';
import { setCredentials } from '../../store/slices/auth.slice';
import { baseApi } from '../../store/api/base.api';
import { CalendarClient } from './CalendarClient';
import { COVERAGE_NOTE, EXPECTED_TIME_NOTE, THIRD_PARTY_IMPACT_LABEL, THIRD_PARTY_LABEL, eventWhen } from '../../lib/calendar';
import type { CalendarEvent } from '../../types/api.types';

// A recorded domain-service response (__fixtures__/README.md); only fetch is mocked.
const BODY = readFileSync(join(__dirname, '__fixtures__', 'calendar-2026-11-06-ff.json'));
const EVENTS = JSON.parse(BODY.toString('utf8')) as CalendarEvent[];

describe('CalendarClient', () => {
  beforeEach(() => {
    store.dispatch(setCredentials({ accessToken: 'tok', user: { id: 'u1' } as never }));
    store.dispatch(baseApi.util.resetApiState());
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      return url.startsWith('http://localhost/api/domain/calendar')
        ? new Response(BODY, { status: 200, headers: { 'Content-Type': 'application/json' } })
        : new Response('{}', { status: 404 });
    });
  });
  afterEach(() => jest.restoreAllMocks());

  it('lists every event with its date, source attribution and "—" for the values no source publishes', async () => {
    expect(EVENTS.length).toBeGreaterThan(0);
    render(<Provider store={store}><CalendarClient /></Provider>);
    const rows = await screen.findAllByTestId('calendar-event');
    expect(rows).toHaveLength(EVENTS.length);

    const ecb = EVENTS.findIndex((e) => e.source === 'ECB');
    const cells = within(rows[ecb]).getAllByRole('cell').map((c) => c.textContent);
    expect(cells).toEqual([
      'Thu 17 Dec 2026· 13:15 UTC', 'EUR',
      'Governing Council of the ECB: monetary policy meeting in Frankfurt (Day 2), followed by press conference',
      'HIGH', 'European Central Bank', '—', '—', '—',
    ]);
    const link = within(rows[ecb]).getByRole('link');
    expect(link.getAttribute('href')).toBe('https://www.ecb.europa.eu/press/calendars/mgcgc/html/index.en.html');
    expect(screen.getByRole('columnheader', { name: 'Date (UTC)' })).toBeTruthy();
  });

  it('labels an FOMC time as expected, with the note on where it comes from', async () => {
    render(<Provider store={store}><CalendarClient /></Provider>);
    const rows = await screen.findAllByTestId('calendar-event');
    const fomc = EVENTS.findIndex((e) => e.source === 'FOMC');
    expect(EVENTS[fomc].timeSource).toBe('expected');
    expect(within(rows[fomc]).getAllByRole('cell')[0].textContent)
      .toBe('Wed 9 Dec 2026· 19:00 UTC (expected)' + EXPECTED_TIME_NOTE);
    expect(EXPECTED_TIME_NOTE).toBe('Fed publishes no standard release time; based on recent statements.');
    // official times carry no note
    expect(within(rows[EVENTS.findIndex((e) => e.source === 'ECB')]).queryByTestId('calendar-expected-note')).toBeNull();
    expect(screen.getAllByTestId('calendar-expected-note')).toHaveLength(EVENTS.filter((e) => e.timeSource === 'expected').length);
  });

  it('marks a Forex Factory row "via ForexFactory" with its impact labelled as ForexFactory’s', async () => {
    render(<Provider store={store}><CalendarClient /></Provider>);
    const rows = await screen.findAllByTestId('calendar-event');
    const ff = EVENTS.findIndex((e) => e.source === 'FOREXFACTORY');
    expect(EVENTS.filter((e) => e.source === 'FOREXFACTORY').length).toBeGreaterThan(0);
    const cells = within(rows[ff]).getAllByRole('cell').map((c) => c.textContent);
    expect(cells).toEqual([
      'Fri 6 Nov 2026· 07:00 UTC', 'EUR', 'German Industrial Production m/m',
      'LOW' + THIRD_PARTY_IMPACT_LABEL, THIRD_PARTY_LABEL, '—', '—', '—',
    ]);
    expect(THIRD_PARTY_LABEL).toBe('via ForexFactory');
    expect(THIRD_PARTY_IMPACT_LABEL).toBe('ForexFactory impact');
    expect(within(rows[ff]).getByRole('link').getAttribute('href')).toBe('https://www.forexfactory.com/calendar');
    // official rows carry no third-party label
    const ecb = EVENTS.findIndex((e) => e.source === 'ECB');
    expect(within(rows[ecb]).queryByText(THIRD_PARTY_IMPACT_LABEL)).toBeNull();
  });

  it('states the coverage and the impact labelling, and cites every source', async () => {
    render(<Provider store={store}><CalendarClient /></Provider>);
    await screen.findAllByTestId('calendar-event');
    expect(screen.getByTestId('calendar-coverage').textContent).toBe(COVERAGE_NOTE);
    expect(COVERAGE_NOTE).toContain('FOMC and ECB from official sources; all other events via Forex Factory. '
      + 'Direct BLS access is blocked (HTTP 403, 2026-11-06).');
    const footer = screen.getByTestId('calendar-footer').textContent ?? '';
    expect(footer).toContain('Board of Governors of the Federal Reserve System');
    expect(footer).toContain('European Central Bank');
    expect(footer).toContain('Forex Factory');
    expect(footer).toContain('Impact is a ForexEdge classification for FOMC and ECB events and ForexFactory’s own level for the others.');
    for (const currency of ['GBP', 'JPY', 'AUD', 'CNY']) expect(screen.getByRole('button', { name: currency })).toBeTruthy();
  });

  it('shows every time in UTC, labelled, whatever the viewer’s zone, across a DST change', () => {
    // 18 Mar 2026: New York already on EDT (8 Mar), so the expected 2:00 p.m. is 18:00 UTC
    expect(eventWhen({ scheduledAt: '2026-03-18T18:00:00.000Z', timeSource: 'expected' }))
      .toEqual({ date: 'Wed 18 Mar 2026', time: '18:00 UTC (expected)' });
    expect(eventWhen({ scheduledAt: '2026-12-17T13:15:00.000Z', timeSource: 'official' }))
      .toEqual({ date: 'Thu 17 Dec 2026', time: '13:15 UTC' });
    // just after midnight UTC stays on its UTC date
    expect(eventWhen({ scheduledAt: '2026-11-07T00:05:00.000Z', timeSource: 'official' }))
      .toEqual({ date: 'Sat 7 Nov 2026', time: '00:05 UTC' });
  });
});
