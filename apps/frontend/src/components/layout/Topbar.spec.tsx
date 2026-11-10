/** @jest-environment ./test/jsdom-with-fetch.cjs */
import { act, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { store } from '../../store';
import { baseApi } from '../../store/api/base.api';
import { setCredentials } from '../../store/slices/auth.slice';
import { LiveConnection } from './LiveConnection';
import { Topbar } from './Topbar';

// The status dot through the real socket hook and store: a fake ws-gateway socket delivers
// feed:status payloads in ws-gateway's shape (FeedStatusEvent).

type Handler = (...args: unknown[]) => void;
class FakeSocket {
  handlers = new Map<string, Handler[]>();
  io = { on: () => undefined, removeAllListeners: () => undefined };
  on(event: string, h: Handler) { this.handlers.set(event, [...(this.handlers.get(event) ?? []), h]); return this; }
  emit() { return this; }
  removeAllListeners() { this.handlers.clear(); return this; }
  connect() { return this; }
  disconnect() { return this; }
  serve(event: string, ...args: unknown[]) { act(() => { for (const h of this.handlers.get(event) ?? []) h(...args); }); }
}
let socket: FakeSocket;
jest.mock('socket.io-client', () => ({ io: () => socket }));
jest.mock('next/navigation', () => ({ useRouter: () => ({ replace: jest.fn() }), usePathname: () => '/dashboard' }));

const dot = () => screen.getByTestId('live-indicator');

beforeEach(() => {
  socket = new FakeSocket();
  store.dispatch(baseApi.util.resetApiState());
  store.dispatch(setCredentials({ accessToken: 'tok', user: { id: 'u1', username: 'trader' } as never }));
  jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 404 }));
});
afterEach(() => jest.restoreAllMocks());

function renderTopbar() {
  return render(<Provider store={store}><LiveConnection /><Topbar /></Provider>);
}

describe('Topbar status dot', () => {
  it('is Connecting, then follows what ws-gateway reports, and is never green for a mock feed', () => {
    renderTopbar();
    expect(dot().textContent).toBe('Connecting');
    socket.serve('connect');
    expect(dot().textContent).toBe('Disconnected'); // connected, but no report yet
    socket.serve('feed:status', { state: 'none', lastTickAgeMs: null });
    expect([dot().textContent, dot().dataset['tone']]).toEqual(['No live feed', 'grey']);
    socket.serve('feed:status', { state: 'mock', lastTickAgeMs: 120 });
    expect([dot().textContent, dot().dataset['tone']]).toEqual(['Mock feed', 'amber']);
    socket.serve('feed:status', { state: 'live', lastTickAgeMs: 300 });
    expect([dot().textContent, dot().dataset['tone']]).toEqual(['Live', 'green']);
    socket.serve('disconnect', 'transport close');
    expect([dot().textContent, dot().dataset['tone']]).toEqual(['Disconnected', 'grey']);
  });

  it('no other green dot in the bar', () => {
    const { container } = renderTopbar();
    socket.serve('connect');
    socket.serve('feed:status', { state: 'none', lastTickAgeMs: null });
    expect(container.querySelectorAll('.bg-accent-green')).toHaveLength(0);
  });
});
