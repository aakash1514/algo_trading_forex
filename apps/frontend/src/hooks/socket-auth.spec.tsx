/** @jest-environment ./test/jsdom-with-fetch.cjs */
import { act, render, renderHook, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import type { ReactNode } from 'react';
import { store } from '../store';
import { clearCredentials, setCredentials } from '../store/slices/auth.slice';
import { refreshSession } from '../lib/session';
import { LoginForm } from '../components/auth/LoginForm';
import { useForexSocket } from './useForexSocket';
import { useReplaySocket } from './useReplaySocket';
import { refreshDelayMs, useTokenRefresh } from './useTokenRefresh';

// Access-token expiry on the two sockets, through the real store and hooks. Only the edges are
// replaced: socket.io-client by a fake socket, and the refresh call (lib/session) by a mock.

type Handler = (...args: unknown[]) => void;
class FakeSocket {
  handlers = new Map<string, Handler[]>();
  connected = false;
  active = true;
  connects = 0;
  emitted: { name: string; body: unknown }[] = [];
  auth: (cb: (data: { token: string }) => void) => void;
  io = { on: () => undefined, removeAllListeners: () => undefined };
  constructor(options: { auth: FakeSocket['auth'] }) { this.auth = options.auth; }
  on(event: string, h: Handler) { this.handlers.set(event, [...(this.handlers.get(event) ?? []), h]); return this; }
  removeAllListeners() { this.handlers.clear(); return this; }
  emit(name: string, body?: unknown) { this.emitted.push({ name, body }); return this; }
  timeout() {
    return { emitWithAck: (name: string, body: unknown) => { this.emitted.push({ name, body }); return Promise.resolve({ ok: true }); } };
  }
  connect() { this.connects += 1; return this; }
  disconnect() { this.connected = false; return this; }
  // the token the socket would send at its next handshake
  token() { let t = ''; this.auth((d) => (t = d.token)); return t; }
  async serve(event: string, ...args: unknown[]) {
    await act(async () => { for (const h of this.handlers.get(event) ?? []) await h(...args); });
  }
  async open() { this.connected = true; await this.serve('connect'); }
  // what ws-gateway / replay-service do when the token expires: authExpired, then a server disconnect
  async expire() { await this.serve('authExpired'); this.connected = false; await this.serve('disconnect', 'io server disconnect'); }
}

let sockets: FakeSocket[] = [];
jest.mock('socket.io-client', () => ({
  io: (_url: string, options: { auth: FakeSocket['auth'] }) => { const s = new FakeSocket(options); sockets.push(s); return s; },
}));
jest.mock('../lib/session', () => ({ ...jest.requireActual('../lib/session'), refreshSession: jest.fn() }));
jest.mock('next/navigation', () => ({ useRouter: () => ({ replace: jest.fn(), push: jest.fn() }) }));
const refresh = refreshSession as jest.MockedFunction<typeof refreshSession>;

const wrapper = ({ children }: { children: ReactNode }) => <Provider store={store}>{children}</Provider>;
const user = { id: 'u1' } as never;
const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (expSeconds: number, tag: string) => `${b64({ alg: 'HS256' })}.${b64({ sub: 'u1', exp: expSeconds, tag })}.sig`;

beforeEach(() => {
  sockets = [];
  refresh.mockReset();
  store.dispatch(clearCredentials());
  store.dispatch(setCredentials({ accessToken: 'token-1', user }));
});

describe('ws-gateway socket (useForexSocket)', () => {
  it('a token refresh doesn\'t tear the socket down; the next handshake uses the new token', async () => {
    renderHook(() => useForexSocket(), { wrapper });
    await sockets[0].open();
    act(() => { store.dispatch(setCredentials({ accessToken: 'token-2', user })); });
    expect(sockets).toHaveLength(1);
    expect(sockets[0].token()).toBe('token-2');
  });

  it('authExpired: renews once and reconnects with the fresh token, resubscribing on connect', async () => {
    refresh.mockResolvedValue({ accessToken: 'token-2', user });
    renderHook(() => useForexSocket(), { wrapper });
    await sockets[0].open();
    sockets[0].emitted = [];
    await sockets[0].expire();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(sockets[0].connects).toBe(1);
    expect(sockets[0].token()).toBe('token-2');
    await sockets[0].open();
    expect(sockets[0].emitted.filter((e) => e.name === 'subscribe:ticker')).toHaveLength(4);
    expect(store.getState().auth.isAuthenticated).toBe(true);
  });

  it('authExpired and the refresh fails: "Session expired", and it never reconnects', async () => {
    refresh.mockResolvedValue(null);
    renderHook(() => useForexSocket(), { wrapper });
    await sockets[0].open();
    await sockets[0].expire();
    expect(store.getState().auth).toMatchObject({ isAuthenticated: false, sessionExpired: true, accessToken: null });
    expect(sockets[0].connects).toBe(0);
    await sockets[0].serve('disconnect', 'io server disconnect'); // nothing more happens
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(sockets[0].connects).toBe(0);
    render(<Provider store={store}><LoginForm /></Provider>);
    expect(screen.getByRole('status').textContent).toBe('Session expired, please log in');
  });

  it('refused again right after a fresh token: stops instead of looping refresh and connect', async () => {
    refresh.mockResolvedValue({ accessToken: 'token-2', user });
    renderHook(() => useForexSocket(), { wrapper });
    await sockets[0].open();
    await sockets[0].expire();
    await sockets[0].open();
    await sockets[0].expire();
    await sockets[0].expire();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(sockets[0].connects).toBe(1);
  });
});

describe('replay socket (useReplaySocket)', () => {
  it('sends every new token as a reauth while connected', async () => {
    renderHook(() => useReplaySocket(), { wrapper });
    await sockets[0].open();
    act(() => { store.dispatch(setCredentials({ accessToken: 'token-2', user })); });
    expect(sockets[0].emitted).toEqual([{ name: 'reauth', body: { token: 'token-2' } }]);
    expect(sockets).toHaveLength(1);
  });

  it('authExpired: renews once and connects again', async () => {
    refresh.mockResolvedValue({ accessToken: 'token-2', user });
    renderHook(() => useReplaySocket(), { wrapper });
    await sockets[0].open();
    await sockets[0].expire();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(sockets[0].connects).toBe(1);
    expect(sockets[0].token()).toBe('token-2');
  });

  it('authExpired and the refresh fails: "Session expired", and it never reconnects', async () => {
    refresh.mockResolvedValue(null);
    renderHook(() => useReplaySocket(), { wrapper });
    await sockets[0].open();
    await sockets[0].expire();
    expect(store.getState().auth.sessionExpired).toBe(true);
    expect(sockets[0].connects).toBe(0);
  });
});

describe('useTokenRefresh', () => {
  afterEach(() => jest.useRealTimers());

  it('refreshes a minute before expiry (halfway for a token with under two minutes left)', () => {
    expect(refreshDelayMs(900_000, 0)).toBe(840_000);
    expect(refreshDelayMs(90_000, 0)).toBe(45_000);
    expect(refreshDelayMs(-5, 0)).toBe(0);
  });

  it('stores the refreshed token at the scheduled time', async () => {
    jest.useFakeTimers({ now: 1_000_000_000_000 });
    refresh.mockResolvedValue({ accessToken: 'token-2', user });
    act(() => { store.dispatch(setCredentials({ accessToken: jwt(1_000_000_000 + 900, 'a'), user })); });
    renderHook(() => useTokenRefresh(), { wrapper });
    await act(async () => { await jest.advanceTimersByTimeAsync(839_000); });
    expect(refresh).not.toHaveBeenCalled();
    await act(async () => { await jest.advanceTimersByTimeAsync(1_000); });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(store.getState().auth.accessToken).toBe('token-2');
  });

  it('a failed scheduled refresh ends the session as expired', async () => {
    jest.useFakeTimers({ now: 1_000_000_000_000 });
    refresh.mockResolvedValue(null);
    act(() => { store.dispatch(setCredentials({ accessToken: jwt(1_000_000_000 + 900, 'b'), user })); });
    renderHook(() => useTokenRefresh(), { wrapper });
    await act(async () => { await jest.advanceTimersByTimeAsync(840_000); });
    expect(store.getState().auth.sessionExpired).toBe(true);
  });
});
