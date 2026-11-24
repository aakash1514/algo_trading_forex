/** @jest-environment ./test/jsdom-with-fetch.cjs */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ReplayAccount, ReplayState, SessionsPage, SwitchedEvent } from '../../types/replay.types';
import { fixture, page, raw, renderPage, rest, serve, setupReplayPage, writes } from './__harness__/page';

// "My replays" through the real page, store and RTK Query, with the recorded replay-service
// bodies: a GBP/USD session titled with markup and a XAU/USD one, switched between, renamed,
// a paused one refused for deletion and an ended one deleted, 21 sessions over two pages.

jest.mock('lightweight-charts', () => jest.requireActual('./__harness__/mocks').chartLibrary);
jest.mock('socket.io-client', () => ({ io: () => jest.requireActual('./__harness__/mocks').sockets.current }));

setupReplayPage();

const PAGE1 = fixture<SessionsPage>('sessions-200-page1');
const PAGE2 = fixture<SessionsPage>('sessions-200-page2');
const BEFORE = fixture<ReplayState>('state-before-switch');
const OPENED = fixture<ReplayState>('open-200-paused');
const ENDED = fixture<ReplayState>('open-200-ended');
const SWITCHED = fixture<SwitchedEvent>('switched');
const list = () => [
  rest('GET', '', 'sessions-200-page1', 200),
  rest('GET', `?cursor=${PAGE1.nextCursor}`, 'sessions-200-page2', 200),
];
const rows = () => screen.getAllByTestId('replay-session-row');
const row = (id: string) => rows().find((r) => r.getAttribute('data-id') === id) as HTMLElement;

async function landing(state: unknown = BEFORE, ...more: ReturnType<typeof rest>[]) {
  serve(...list(), ...more);
  const view = renderPage();
  page.socket.open(state);
  await waitFor(() => expect(rows()).toHaveLength(20));
  return view;
}

describe('My replays: the list', () => {
  it('shows the user\'s sessions, last opened first, with status, replay time and closed-trade P&L; Load more adds the rest', async () => {
    await landing();
    expect(rows().map((r) => r.getAttribute('data-id'))).toEqual(PAGE1.sessions.map((s) => s.id));
    const statuses = screen.getAllByTestId('replay-session-status').map((s) => s.textContent);
    expect(statuses).toEqual(PAGE1.sessions.map((s) => (s.status === 'ENDED' ? 'Ended' : s.current ? 'Active' : 'Paused')));
    expect(statuses.filter((s) => s === 'Active')).toHaveLength(1);
    expect(statuses).toEqual(expect.arrayContaining(['Active', 'Paused', 'Ended']));
    const first = PAGE1.sessions[0];
    expect(within(row(first.id)).getByText('2019-12-12 21:00 UTC')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Net P&L (closed trades)' })).toBeTruthy();
    const net = screen.getAllByTestId('replay-session-net').map((c) => c.textContent);
    expect(net.every((t) => /^[+-]\$[\d,]+\.\d{2}$/.test(t ?? ''))).toBe(true);

    fireEvent.click(screen.getByTestId('replay-sessions-load-more'));
    await waitFor(() => expect(rows()).toHaveLength(21));
    expect(rows().map((r) => r.getAttribute('data-id'))).toEqual([...PAGE1.sessions, ...PAGE2.sessions].map((s) => s.id));
    expect(new Set(rows().map((r) => r.getAttribute('data-id'))).size).toBe(21);
    expect(screen.queryByTestId('replay-sessions-load-more')).toBeNull();
  });

  it('a title is plain text: markup is shown as written, never rendered', async () => {
    const { container } = await landing();
    const titled = PAGE1.sessions.find((s) => s.title.includes('<b>'));
    expect(titled?.title).toBe('<b>UK election</b> & GBP');
    expect(within(row(titled!.id)).getByTestId('replay-session-title').textContent).toBe('<b>UK election</b> & GBP');
    expect(container.querySelector('b')).toBeNull();
  });
});

describe('My replays: rename', () => {
  it('Enter saves through PATCH and the list reloads; Esc cancels without a request', async () => {
    const target = PAGE1.sessions[1];
    await landing(BEFORE, rest('PATCH', `/${target.id}`, 'rename-200', 200));
    fireEvent.click(within(row(target.id)).getByRole('button', { name: `Rename ${target.title}` }));
    const input = within(row(target.id)).getByLabelText('Title') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Something else' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(within(row(target.id)).queryByLabelText('Title')).toBeNull();
    expect(writes()).toEqual([]);

    const listReads = () => page.calls.filter((c) => c.method === 'GET').length;
    const readsBefore = listReads();
    fireEvent.click(within(row(target.id)).getByRole('button', { name: `Rename ${target.title}` }));
    fireEvent.change(within(row(target.id)).getByLabelText('Title'), { target: { value: '  Gold, March 2020 crash  ' } });
    fireEvent.submit(screen.getByTestId('replay-rename-form'));
    await waitFor(() => expect(writes()).toEqual([{
      method: 'PATCH', url: `http://localhost/api/replay/sessions/${target.id}`, body: { title: '  Gold, March 2020 crash  ' },
    }]));
    await waitFor(() => expect(listReads()).toBeGreaterThan(readsBefore)); // the server's order and titles again
  });

  it('the server\'s refusal shows under the field, in plain words; the count is in characters', async () => {
    const target = PAGE1.sessions[1];
    await landing(BEFORE, rest('PATCH', `/${target.id}`, 'rename-400-too-long', 400));
    fireEvent.click(within(row(target.id)).getByRole('button', { name: `Rename ${target.title}` }));
    const emoji = String.fromCodePoint(0x1f4c8);
    fireEvent.change(within(row(target.id)).getByLabelText('Title'), { target: { value: `${emoji}${'x'.repeat(60)}` } });
    expect(within(row(target.id)).getByText('61/60')).toBeTruthy(); // the emoji counts as one
    fireEvent.submit(screen.getByTestId('replay-rename-form'));
    expect((await screen.findByTestId('replay-rename-error')).textContent).toBe('Title must be at most 60 characters');
    expect(within(row(target.id)).getByLabelText('Title')).toBeTruthy(); // still editing
  });
});

describe('My replays: delete', () => {
  it('only ENDED sessions offer Delete; the dialog names the session, Cancel keeps it, Delete removes it', async () => {
    const ended = PAGE1.sessions.filter((s) => s.status === 'ENDED');
    expect(ended.length).toBeGreaterThan(0);
    const target = ended[0];
    await landing(BEFORE, rest('DELETE', `/${target.id}`, 'delete-204', 204));
    expect(screen.getAllByRole('button', { name: /^Delete / }).map((b) => b.closest('tr')?.getAttribute('data-id')))
      .toEqual(ended.map((s) => s.id));

    fireEvent.click(within(row(target.id)).getByRole('button', { name: `Delete ${target.title}` }));
    const dialog = await screen.findByTestId('replay-delete-dialog');
    expect(within(dialog).getByRole('heading').textContent).toBe(`Delete ‘${target.title}’? This can't be undone.`);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByTestId('replay-delete-dialog')).toBeNull());
    expect(writes()).toEqual([]);

    fireEvent.click(within(row(target.id)).getByRole('button', { name: `Delete ${target.title}` }));
    fireEvent.click(within(await screen.findByTestId('replay-delete-dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(writes()).toEqual([
      { method: 'DELETE', url: `http://localhost/api/replay/sessions/${target.id}`, body: undefined },
    ]));
    await waitFor(() => expect(screen.queryByTestId('replay-delete-dialog')).toBeNull());
  });

  it('a refusal from the server stays in the dialog', async () => {
    const target = PAGE1.sessions.find((s) => s.status === 'ENDED')!;
    await landing(BEFORE, rest('DELETE', `/${target.id}`, 'delete-409-paused', 409));
    fireEvent.click(within(row(target.id)).getByRole('button', { name: `Delete ${target.title}` }));
    const dialog = await screen.findByTestId('replay-delete-dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('End the session before deleting it');
  });
});

describe('My replays: opening', () => {
  it('a paused session opens on the replay screen, paused, where it stopped; nothing plays by itself', async () => {
    await landing(BEFORE, rest('POST', `/${OPENED.session.id}/open`, 'open-200-paused', 200));
    fireEvent.click(within(row(OPENED.session.id)).getByRole('button', { name: `Open ${OPENED.session.title}` }));
    expect((await screen.findByTestId('replay-title')).textContent).toBe('<b>UK election</b> & GBP');
    expect(screen.getByTestId('replay-status').textContent).toBe('Paused');
    expect(screen.getByTestId('replay-clock').textContent).toBe(`Replay time: 2019-12-12 21:00 UTC`);
    expect(OPENED.session.clockTime).toBe('2019-12-12T21:00:00.000Z');
    expect(page.socket.sent.map((s) => s.name)).not.toContain('play');
  });

  it('an ENDED session opens read-only: its chart, closed trades and statistics, no controls, orders or shortcuts', async () => {
    await landing(BEFORE, rest('POST', `/${ENDED.session.id}/open`, 'open-200-ended', 200),
      rest('GET', `/${ENDED.session.id}/trades`, 'trades-200-page1', 200));
    fireEvent.click(within(row(ENDED.session.id)).getByRole('button', { name: `View ${ENDED.session.title}` }));
    await screen.findByTestId('replay-ended-view');
    expect(screen.getByTestId('replay-read-only').textContent).toBe('Read-only');
    expect(screen.getByTestId('replay-clock').textContent).toBe(`Ended at replay time ${ENDED.session.clockTime.slice(0, 10)} ${ENDED.session.clockTime.slice(11, 16)} UTC`);
    expect(screen.queryByTestId('replay-order-panel')).toBeNull();
    expect(screen.queryByTestId('replay-play')).toBeNull();
    expect(screen.queryByTestId('replay-step')).toBeNull();
    expect(screen.queryByRole('button', { name: 'End session' })).toBeNull();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([expect.stringMatching(/^Closed trades/), 'Statistics']);
    expect(mockChart().setData.at(-1)).toHaveLength(ENDED.bars.length + 1);
    // the shortcuts aren't there: Space, → and B send nothing
    for (const key of [' ', 'ArrowRight', 'b']) fireEvent.keyDown(window, { key });
    expect(page.socket.sent).toEqual([]);
    // a reconnect's state (the current session) doesn't replace what is being viewed
    act(() => page.socket.open(BEFORE));
    expect(screen.getByTestId('replay-ended-view')).toBeTruthy();
    expect(screen.getByTestId('replay-title').textContent).toBe(ENDED.session.title);
  });

  it('a refusal to open (another user\'s session) is shown in plain words', async () => {
    const target = PAGE1.sessions[2];
    await landing(BEFORE, { method: 'POST', path: `/${target.id}/open`, status: 404, body: raw('open-404') });
    fireEvent.click(within(row(target.id)).getByRole('button', { name: /^(Open|View) / }));
    expect((await screen.findByTestId('replay-open-error')).textContent).toBe('No such replay session');
  });
});

describe('a tab left on a session the user switched away from', () => {
  it('shows the banner, disables the controls, ignores the other session\'s events, and can open its own again', async () => {
    serve(...list(), rest('POST', `/${BEFORE.session.id}/open`, 'open-200-paused', 200));
    renderPage();
    page.socket.open(BEFORE);
    fireEvent.click(await screen.findByRole('button', { name: 'Resume' }));
    expect(screen.getByTestId('replay-title').textContent).toBe(BEFORE.session.title);
    expect(SWITCHED.openedSessionId).not.toBe(BEFORE.session.id);

    act(() => page.socket.serve('switched', SWITCHED));
    expect(screen.getByTestId('replay-switched-banner').textContent).toContain('This replay was paused because you opened another one.');
    expect((screen.getByTestId('replay-play') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('replay-step') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(window, { key: ' ' });
    expect(page.socket.sent).toEqual([]);

    // the other session's account never lands on this page
    const before = screen.getByTestId('replay-account').textContent;
    act(() => page.socket.serve('account', { ...OPENED.account, equity: '1.00' } satisfies ReplayAccount));
    expect(OPENED.account.sessionId).toBe(SWITCHED.openedSessionId);
    expect(screen.getByTestId('replay-account').textContent).toBe(before);

    fireEvent.click(screen.getByRole('button', { name: 'Open this replay' }));
    await waitFor(() => expect(writes()).toEqual([
      { method: 'POST', url: `http://localhost/api/replay/sessions/${BEFORE.session.id}/open`, body: undefined },
    ]));
  });
});

function mockChart() {
  return jest.requireActual('./__harness__/mocks').mockChart as { setData: unknown[][] };
}
