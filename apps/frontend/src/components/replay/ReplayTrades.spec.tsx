/** @jest-environment ./test/jsdom-with-fetch.cjs */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { mergeClosedTrades } from '../../lib/replay';
import type { ReplayPosition, ReplayState, TradesPage } from '../../types/replay.types';
import { fixture, openScreen, page, raw, serve, setupReplayPage } from './__harness__/page';

// The closed-trade history through the real page, store and RTK Query, with the recorded
// replay-service bodies of the 2022-03-16 session: 21 trades closed in one minute (a page
// of 20 with a cursor, then the last one), then a 22nd trade closing by socket.

jest.mock('lightweight-charts', () => jest.requireActual('./__harness__/mocks').chartLibrary);
jest.mock('socket.io-client', () => ({ io: () => jest.requireActual('./__harness__/mocks').sockets.current }));

setupReplayPage();

const STATE = fixture<ReplayState>('state-calendar-after');
const PAGE1 = fixture<TradesPage>('trades-200-page1');
const PAGE2 = fixture<TradesPage>('trades-200-page2');
const LATER = fixture<ReplayPosition[]>('positions-closed-later');
const SID = STATE.session.id;
const routes = () => [
  { method: 'GET', path: `/${SID}/trades`, status: 200, body: raw('trades-200-page1') },
  { method: 'GET', path: `/${SID}/trades?cursor=${PAGE1.nextCursor}`, status: 200, body: raw('trades-200-page2') },
];
const rowIds = () => screen.getAllByTestId('replay-closed-row').map((r) => r.getAttribute('data-id'));
const tradeCalls = () => page.calls.filter((c) => c.url.includes('/trades'));

async function openClosedTab() {
  await openScreen(STATE);
  serve(...routes());
  fireEvent.click(screen.getByRole('tab', { name: /Closed trades/ }));
  await waitFor(() => expect(screen.getAllByTestId('replay-closed-row')).toHaveLength(20));
}

describe('closed-trade history: Load more', () => {
  it('the recorded pages: 20 with a cursor, then the last one; all 21 closed in one minute', () => {
    expect(PAGE1.trades).toHaveLength(20);
    expect(PAGE1.nextCursor).not.toBeNull();
    expect(PAGE2.trades).toHaveLength(1);
    expect(PAGE2.nextCursor).toBeNull();
    expect(new Set([...PAGE1.trades, ...PAGE2.trades].map((t) => t.exitTime)).size).toBe(1);
    expect(LATER.some((p) => p.status === 'CLOSED' && (p.exitTime ?? '') > (PAGE1.trades[0].exitTime ?? ''))).toBe(true);
  });

  it('opening the tab loads page 1; Load more appends page 2 and disappears on the last page', async () => {
    await openClosedTab();
    expect(rowIds()).toEqual(PAGE1.trades.map((t) => t.id));
    expect(screen.getByRole('tab', { name: /Closed trades/ }).textContent).toBe('Closed trades (20+)');
    fireEvent.click(screen.getByTestId('replay-load-more'));
    await waitFor(() => expect(screen.getAllByTestId('replay-closed-row')).toHaveLength(21));
    expect(rowIds()).toEqual([...PAGE1.trades, ...PAGE2.trades].map((t) => t.id));
    expect(screen.queryByTestId('replay-load-more')).toBeNull();
    expect(screen.getByRole('tab', { name: /Closed trades/ }).textContent).toBe('Closed trades (21)');
    expect(tradeCalls().map((c) => c.url)).toEqual([
      `http://localhost/api/replay/sessions/${SID}/trades`,
      `http://localhost/api/replay/sessions/${SID}/trades?cursor=${PAGE1.nextCursor}`,
    ]);
  });

  it('a trade closing by socket goes on top; the loaded rows stay, none twice', async () => {
    await openClosedTab();
    page.socket.serve('positions', LATER);
    const closedLater = LATER.find((p) => p.status === 'CLOSED') as ReplayPosition;
    await waitFor(() => expect(screen.getAllByTestId('replay-closed-row')).toHaveLength(21));
    expect(rowIds()).toEqual([closedLater.id, ...PAGE1.trades.map((t) => t.id)]);
    fireEvent.click(screen.getByTestId('replay-load-more'));
    await waitFor(() => expect(screen.getAllByTestId('replay-closed-row')).toHaveLength(22));
    expect(rowIds()).toEqual([closedLater.id, ...PAGE1.trades.map((t) => t.id), PAGE2.trades[0].id]);
    page.socket.serve('positions', [PAGE1.trades[3]]); // a loaded trade sent again
    expect(rowIds()).toHaveLength(22);
    expect(within(screen.getAllByTestId('replay-closed-row')[0]).getAllByRole('cell')[0].textContent)
      .toBe(`${(closedLater.exitTime ?? '').slice(0, 10)} ${(closedLater.exitTime ?? '').slice(11, 16)} UTC`);
  });

  it('a refused page shows the server’s message', async () => {
    await openScreen(STATE);
    serve({ method: 'GET', path: `/${SID}/trades`, status: 404, body: raw('trades-404') });
    fireEvent.click(screen.getByRole('tab', { name: /Closed trades/ }));
    expect((await screen.findByTestId('replay-trades-error')).textContent).toBe('Replay session not found');
  });
});

describe('mergeClosedTrades', () => {
  it('one row per id, the store’s copy wins, newest first by exit time then id', () => {
    const [a, b] = PAGE1.trades;
    const newer = { ...a, realizedPnlUsd: a.realizedPnlUsd }; // the store's copy of a loaded trade
    const merged = mergeClosedTrades([newer], [a, b]);
    expect(merged).toHaveLength(2);
    expect(merged.find((t) => t.id === a.id)).toBe(newer);
    expect(merged.map((t) => t.id)).toEqual([a.id, b.id].sort().reverse()); // same exit time: id descending
  });
});
