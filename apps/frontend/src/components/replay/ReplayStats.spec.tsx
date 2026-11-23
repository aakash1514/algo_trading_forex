/** @jest-environment ./test/jsdom-with-fetch.cjs */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { ReplayPosition, ReplayState, ReplayStats } from '../../types/replay.types';
import { fixture, openScreen, page, raw, serve, setupReplayPage } from './__harness__/page';

// The Statistics tab through the real page, store and RTK Query, with replay-service's
// recorded /stats bodies of the 2022-03-16 session: before any trade (zeros and "—"),
// and after its 22 trades; the 22nd close arrives by socket and makes the tab ask again.

jest.mock('lightweight-charts', () => jest.requireActual('./__harness__/mocks').chartLibrary);
jest.mock('socket.io-client', () => ({ io: () => jest.requireActual('./__harness__/mocks').sockets.current }));

setupReplayPage();

const STATE = fixture<ReplayState>('state-calendar-before');
const SID = STATE.session.id;
const STATS = fixture<ReplayStats>('stats-200');
const route = (name: string) => ({ method: 'GET', path: `/${SID}/stats`, status: 200, body: raw(name) });
const stat = (id: string) => screen.getByTestId(`replay-stat-${id}`).textContent;
const statsCalls = () => page.calls.filter((c) => c.url.endsWith('/stats'));

describe('replay statistics', () => {
  it('an empty session: zeros, and "—" where a value is undefined', async () => {
    await openScreen(STATE);
    serve(route('stats-200-empty'));
    fireEvent.click(screen.getByRole('tab', { name: 'Statistics' }));
    await screen.findByTestId('replay-stats');
    expect([stat('trades'), stat('wins-losses'), stat('win-rate'), stat('net'), stat('profit-factor'),
      stat('average-win'), stat('largest-loss'), stat('drawdown')])
      .toEqual(['0', '0 / 0', '—', '+$0.00', '—', '—', '—', '$0.00 (0.00%)']);
    expect(screen.getByText(/balance after each close/)).toBeTruthy();
  });

  it('a trade closing by socket asks again; the values are the server’s, as sent', async () => {
    await openScreen(STATE);
    serve(route('stats-200-empty'));
    fireEvent.click(screen.getByRole('tab', { name: 'Statistics' }));
    await screen.findByTestId('replay-stats');
    expect(statsCalls()).toHaveLength(1);

    serve(route('stats-200'));
    page.socket.serve('positions', fixture<ReplayPosition[]>('positions-closed-later'));
    await waitFor(() => expect(stat('trades')).toBe(String(STATS.trades)));
    expect(statsCalls()).toHaveLength(2);
    expect(STATS).toMatchObject({ trades: 22, wins: 11, losses: 11, profitFactor: '0.68' });
    expect([stat('wins-losses'), stat('win-rate'), stat('net'), stat('gross-profit'), stat('gross-loss'),
      stat('profit-factor'), stat('average-win'), stat('average-loss'), stat('largest-win'), stat('largest-loss'),
      stat('drawdown')]).toEqual([
      `${STATS.wins} / ${STATS.losses}`, `${STATS.winRatePct}%`, '-$5.03', '$10.70', '-$15.73', STATS.profitFactor,
      '$0.97', '-$1.43', '$1.01', '-$1.43', `$${STATS.maxDrawdownUsd} (${STATS.maxDrawdownPct}%)`,
    ]);

    // positions that close nothing new: no new request
    page.socket.serve('positions', fixture<ReplayPosition[]>('positions-closed-later'));
    await new Promise((r) => setTimeout(r, 50));
    expect(statsCalls()).toHaveLength(2);
  });
});
