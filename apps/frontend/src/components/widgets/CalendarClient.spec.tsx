/** @jest-environment ./test/jsdom-with-fetch.cjs */
import { readFileSync } from 'fs';
import { join } from 'path';
import { render, screen, waitFor, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { store } from '../../store';
import { setCredentials } from '../../store/slices/auth.slice';
import { baseApi } from '../../store/api/base.api';
import { CalendarClient } from './CalendarClient';
import { COVERAGE_NOTE, eventWhen } from '../../lib/calendar';
import type { CalendarEvent } from '../../types/api.types';

// A recorded domain-service response (__fixtures__/README.md); only fetch is mocked.
const BODY = readFileSync(join(__dirname, '__fixtures__', 'calendar-2026-10-12.json'));
const EVENTS = JSON.parse(BODY.toString('utf8')) as CalendarEvent[];

describe('CalendarClient', () => {
  beforeEach(() => {
    store.dispatch(setCredentials({ accessToken: 'tok', user: { id: 'u1' } as never }));
    store.dispatch(baseApi.util.resetApiState());
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      return url.startsWith('http://localhost:3003/api/domain/calendar')
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

    const decision = EVENTS.findIndex((e) => e.impact === 'HIGH');
    const cells = within(rows[decision]).getAllByRole('cell').map((c) => c.textContent);
    expect(cells).toEqual([
      'Thu, 29 Oct 2026All day', 'EUR',
      'Governing Council of the ECB: monetary policy meeting in Frankfurt (Day 2), followed by press conference',
      'HIGH', 'European Central Bank', '—', '—', '—',
    ]);
    const link = within(rows[decision]).getByRole('link');
    expect(link.getAttribute('href')).toBe('https://www.ecb.europa.eu/press/calendars/mgcgc/html/index.en.html');
  });

  it('says what is not covered and that impact is a ForexEdge classification, and cites the sources', async () => {
    render(<Provider store={store}><CalendarClient /></Provider>);
    await screen.findAllByTestId('calendar-event');
    expect(screen.getByTestId('calendar-coverage').textContent).toBe(COVERAGE_NOTE);
    expect(COVERAGE_NOTE).toContain('GBP and JPY events are not available');
    const footer = screen.getByTestId('calendar-footer').textContent ?? '';
    expect(footer).toContain('Board of Governors of the Federal Reserve System');
    expect(footer).toContain('European Central Bank');
    expect(footer).toContain('Impact is a ForexEdge classification, not source data.');
    expect(screen.queryByText('GBP')).toBeNull(); // no filter for currencies without a source
  });

  it('reads an all-day date in UTC, so it never shows as the day before', async () => {
    await waitFor(() => expect(EVENTS[0].allDay).toBe(true));
    expect(eventWhen({ scheduledAt: '2026-10-28T00:00:00.000Z', allDay: true })).toEqual({ date: 'Wed, 28 Oct 2026', time: 'All day' });
  });
});
