/** @jest-environment ./test/jsdom-with-fetch.cjs */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { store } from '../../store';
import type { BarEvent, ReplayState } from '../../types/replay.types';
import { mockChart } from './__harness__/mocks';
import { fixture, openScreen, page, raw, renderPage, rest, serve, setupReplayPage, STATE_PAUSED, writes } from './__harness__/page';

// The Replay page through the real store, RTK Query and socket hook (__harness__/page.tsx).

jest.mock('lightweight-charts', () => jest.requireActual('./__harness__/mocks').chartLibrary);
jest.mock('socket.io-client', () => ({ io: () => jest.requireActual('./__harness__/mocks').sockets.current }));

setupReplayPage();

describe('Replay page: start, resume, end', () => {
  it('without a session shows the start form and refuses a start outside the history before sending', async () => {
    renderPage();
    expect(screen.getByRole('status').textContent).toBe('Connecting to the replay service…');
    page.socket.open(fixture('state-no-session'));
    fireEvent.change(screen.getByLabelText('Start date (UTC)'), { target: { value: '2022-12-31' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start replay' }));
    expect(screen.getByTestId('replay-start-error').textContent)
      .toBe('The start must be between 2010-01-01 00:00 and 2022-12-30 23:59 UTC');
    fireEvent.change(screen.getByLabelText('Start date (UTC)'), { target: { value: '2022-03-01' } });
    fireEvent.change(screen.getByLabelText('Starting balance (USD)'), { target: { value: '50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start replay' }));
    expect(screen.getByTestId('replay-start-error').textContent).toBe('The starting balance must be between $100 and $10,000,000');
    expect(writes()).toEqual([]);
  });

  it('creates the session from the form and opens it paused, with the REPLAY badge and the replay clock', async () => {
    await openScreen();
    expect(writes()).toEqual([{ method: 'POST', url: 'http://localhost/api/replay/sessions',
      body: { instrument: 'EUR_USD', startTime: '2022-03-01T09:30Z', timeframe: '1h', startingBalance: 10000 } }]);
    expect(page.socket.connects).toBe(1); // connected again for the new session's state
    expect(screen.getByTestId('replay-badge').textContent).toBe('REPLAY');
    expect(screen.getByTestId('replay-clock').textContent).toBe(`Replay time: 2022-03-01 09:30 UTC`);
    expect(STATE_PAUSED.session.clockTime).toBe('2022-03-01T09:30:00.000Z');
    expect(screen.getByTestId('replay-status').textContent).toBe('Paused');
    expect(page.socket.sent.map((s) => s.name)).not.toContain('play'); // never plays by itself
  });

  it('ending asks on the page, then shows the summary and goes back to the start form', async () => {
    await openScreen(fixture('state-closed-trades'));
    serve(rest('POST', `/${fixture<ReplayState>('state-closed-trades').session.id}/end`, 'end-200', 200));
    fireEvent.click(screen.getByRole('button', { name: 'End session' }));
    expect(screen.getByTestId('replay-end-confirm').textContent)
      .toContain('Your 1 open position will be closed at the current replay price');
    fireEvent.click(screen.getByRole('button', { name: 'Yes, end the session' }));
    await screen.findByTestId('replay-summary');
    expect(screen.getByTestId('replay-summary-balance').textContent).toBe('$10,000.00 → $9,982.00');
    expect(screen.getByTestId('replay-summary-pnl').textContent).toBe('-$18.00');
    // the long closed by SL and the short closed by hand, plus the short the end closed
    expect(screen.getByTestId('replay-summary-trades').textContent).toBe('3');
    page.socket.serve('ended', fixture('ended')); // the socket's copy changes nothing
    expect(screen.getByTestId('replay-summary-trades').textContent).toBe('3');
    fireEvent.click(screen.getByRole('button', { name: 'New replay' }));
    expect(screen.getByTestId('replay-start-form')).toBeTruthy();
  });
});

describe('Replay page: playback', () => {
  it('loads every bar on a state, updates the current bar on a bar event and ignores another timeframe', async () => {
    await openScreen(fixture('state-paused'));
    const state = fixture<ReplayState>('state-paused');
    expect(state.bars.length).toBeGreaterThan(0);
    expect(mockChart.setData).toHaveLength(1);
    expect(mockChart.setData[0]).toHaveLength(state.bars.length + 1);

    const bar = fixture<BarEvent>('bar-1m');
    expect(bar.bar.time > state.currentBar.time).toBe(true);
    page.socket.serve('bar', bar);
    expect(mockChart.update.at(-1)).toEqual({ time: Date.parse(bar.bar.time) / 1000, open: Number(bar.bar.bid.open),
      high: Number(bar.bar.bid.high), low: Number(bar.bar.bid.low), close: Number(bar.bar.bid.close) });
    expect(store.getState().replay.bars).toHaveLength(state.bars.length + 1); // the old current bar completed
    expect(screen.getByTestId('replay-clock').textContent).toBe(`Replay time: ${bar.clockTime.slice(0, 10)} ${bar.clockTime.slice(11, 16)} UTC`);

    // the same bar again (a fresh copy, as off the wire): redrawn in place, nothing appended
    let updates = mockChart.update.length;
    page.socket.serve('bar', fixture<BarEvent>('bar-1m'));
    expect(mockChart.update).toHaveLength(updates + 1);
    expect(mockChart.update.at(-1)?.time).toBe(Date.parse(bar.bar.time) / 1000);
    expect(store.getState().replay.bars).toHaveLength(state.bars.length + 1);
    updates = mockChart.update.length;
    // the recorded bar with only its timeframe changed: a bar sent before a timeframe switch landed
    page.socket.serve('bar', { ...fixture<BarEvent>('bar-1m'), timeframe: '1h' });
    expect(mockChart.update).toHaveLength(updates);
    expect(mockChart.setData).toHaveLength(1);
  });

  it('disables the controls while a command waits for its acknowledgement, and shows a refusal', async () => {
    await openScreen();
    const play = screen.getByTestId('replay-play') as HTMLButtonElement;
    fireEvent.click(play);
    expect(page.socket.sent.map((s) => s.name)).toEqual(['play']);
    expect(play.disabled).toBe(true);
    expect((screen.getByTestId('replay-step') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '0.5 s' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => page.socket.sent[0].resolve({ ok: false, error: 'Replay command failed' }));
    expect(play.disabled).toBe(false);
    expect(screen.getByTestId('replay-command-error').textContent).toBe('Replay command failed');

    fireEvent.click(screen.getByRole('button', { name: '0.5 s' }));
    expect(page.socket.sent[1]).toMatchObject({ name: 'setSpeed', body: { sessionId: STATE_PAUSED.session.id, speedMs: 500 } });
    fireEvent.click(screen.getByRole('button', { name: '4h' }));
    expect(page.socket.sent).toHaveLength(2); // still waiting for the speed's acknowledgement
  });

  it('shows the pause reason from a status event', async () => {
    const user = fixture<{ id: string; pauseReason: string }>('status-paused-user');
    await openScreen(fixture('state-closed-trades')); // the same session as the status event
    expect(fixture<ReplayState>('state-closed-trades').session.id).toBe(user.id);
    page.socket.serve('status', { ...user, status: 'PLAYING', pauseReason: null }); // the recorded event, as if playing
    expect(screen.getByTestId('replay-status').textContent).toBe('Playing');
    page.socket.serve('status', user);
    expect(screen.getByTestId('replay-status').textContent).toBe('Paused');
    expect(user.pauseReason).toBe('USER');
  });

  it('at the end of the data: the message, and play, step and orders disabled', async () => {
    await openScreen(fixture('state-end-of-data'));
    expect(screen.getByTestId('replay-status').textContent).toBe('End of historical data (30 Dec 2022)');
    expect((screen.getByTestId('replay-play') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('replay-step') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('replay-order-disabled')).toBeTruthy();
  });

  it('a dropped connection shows Reconnecting… with the controls disabled; the reconnect state is paused', async () => {
    await openScreen();
    page.socket.connected = false;
    page.socket.serve('disconnect', 'transport close');
    expect(screen.getByTestId('replay-status').textContent).toBe('Reconnecting…');
    expect((screen.getByTestId('replay-play') as HTMLButtonElement).disabled).toBe(true);
    page.socket.open(fixture('state-paused'));
    expect(screen.getByTestId('replay-status').textContent).toBe('Paused');
    expect(mockChart.setData).toHaveLength(2); // reloaded from the server's state
    expect(page.socket.sent).toEqual([]);
  });

  it('an expired token: refreshes through the shared flow and connects again with the new token', async () => {
    renderPage();
    const refresh = { accessToken: 'tok2', user: { id: 'u1' } };
    jest.spyOn(global, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify(refresh), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    page.socket.serve('replayError', { error: 'Unauthorized' });
    await waitFor(() => expect(page.socket.connects).toBe(1));
    expect(store.getState().auth.accessToken).toBe('tok2');
  });
});

describe('Replay page: orders and positions', () => {
  it('checks SL/TP and lots before sending, and shows the server’s refusal in plain words', async () => {
    await openScreen();
    page.socket.serve('bar', fixture('bar-1m'));
    const { bar } = fixture<BarEvent>('bar-1m');
    expect(screen.getByTestId('replay-bid').textContent).toBe(bar.bid.close);
    expect(screen.getByTestId('replay-ask').textContent).toBe(bar.ask.close);
    expect(screen.getByText('Orders fill at the next minute’s open.'.replace('’', "'"))).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Stop loss'), { target: { value: '1.12082' } });
    fireEvent.click(screen.getByRole('button', { name: 'Buy 0.10 lots' }));
    expect(screen.getByTestId('replay-order-error').textContent).toBe(`Stop loss must be below the bid ${bar.bid.close}`);
    fireEvent.change(screen.getByLabelText('Stop loss'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Lots'), { target: { value: '100.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Buy 100.5 lots' }));
    expect(screen.getByTestId('replay-order-error').textContent).toBe('Lots must be between 0.01 and 100, with at most 2 decimals');
    expect(writes()).toHaveLength(1); // the create only

    serve(rest('POST', `/${STATE_PAUSED.session.id}/orders`, 'order-400-margin', 400));
    fireEvent.change(screen.getByLabelText('Lots'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Buy 100 lots' }));
    await waitFor(() => expect(screen.getByTestId('replay-order-error').textContent)
      .toBe(fixture<{ message: string }>('order-400-margin').message));
    expect(screen.getByTestId('replay-order-error').textContent).toMatch(/^Insufficient margin: need \$[\d.]+, free margin \$[\d.]+$/);
  });

  it('a placed order is Pending with Cancel; filled it is Open with its live P&L; a close is pending', async () => {
    await openScreen();
    serve(rest('POST', `/${STATE_PAUSED.session.id}/orders`, 'order-201-pending', 201));
    fireEvent.click(screen.getByRole('button', { name: 'Buy 0.10 lots' }));
    const row = await screen.findByTestId('replay-position-row');
    expect(within(row).getAllByRole('cell')[0].textContent).toBe('Pending · fills at the next minute\'s open');
    expect(within(row).getByRole('button', { name: 'Cancel' })).toBeTruthy();

    const open = fixture<ReplayState>('state-open-positions');
    page.socket.open(open);
    const rows = screen.getAllByTestId('replay-position-row');
    expect(rows).toHaveLength(open.positions.filter((p) => p.status === 'OPEN').length);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(within(r).getAllByRole('cell')[0].textContent).toBe('Open');
    const pnl = screen.getAllByTestId('replay-position-pnl').map((c) => c.textContent);
    expect(pnl.every((t) => /^[+-]\$\d+\.\d{2}$/.test(t ?? ''))).toBe(true);

    const short = open.positions.find((p) => p.side === 'SELL' && p.status === 'OPEN');
    serve({ method: 'POST', path: `/${STATE_PAUSED.session.id}/positions/${short?.id}/close`, status: 200, body: raw('close-200') });
    const shortRow = rows.find((r) => within(r).queryByText('SHORT')) as HTMLElement;
    fireEvent.click(within(shortRow).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(within(shortRow).getAllByRole('cell')[0].textContent).toBe('Closing at the next minute\'s open'));
    expect((within(shortRow).getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('lists the closed trades of the state, newest first, and the account in USD', async () => {
    const state = fixture<ReplayState>('state-closed-trades');
    await openScreen(state);
    const account = within(screen.getByTestId('replay-account')).getAllByRole('definition').map((d) => d.textContent);
    expect(state.account).toMatchObject({
      balance: '9984.10', equity: '9982.00', unrealizedPnlUsd: '-2.10', marginUsed: '335.87', freeMargin: '9646.13',
    });
    expect(account).toEqual(['$9,984.10', '$9,982.00', '-$2.10', '$335.87', '$9,646.13']);
    fireEvent.click(screen.getByRole('tab', { name: /Closed trades/ }));
    const rows = screen.getAllByTestId('replay-closed-row').map((r) => within(r).getAllByRole('cell').map((c) => c.textContent));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r[1], r[4], r[5]])).toEqual([['LONG', 'Stop loss', '-$11.70'], ['SHORT', 'Manual', '-$4.20']]);
  });
});
