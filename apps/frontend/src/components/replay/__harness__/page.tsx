import { readFileSync } from 'fs';
import { join } from 'path';
import { fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { store } from '../../../store';
import { setCredentials } from '../../../store/slices/auth.slice';
import { baseApi } from '../../../store/api/base.api';
import { ReplayClient } from '../ReplayClient';
import type { ReplayState } from '../../../types/replay.types';
import { FakeSocket, mockChart, sockets } from './mocks';

// The Replay page through the real store, RTK Query and socket hook. Only the edges are
// replaced: fetch answers with recorded replay-service bodies, a fake socket delivers
// recorded socket events (__fixtures__/README.md), and the chart library records calls.
// A spec mocks the chart library and socket.io-client with ./mocks (see there), runs
// setupReplayPage() at its top level, and uses /** @jest-environment ./test/jsdom-with-fetch.cjs */.

const DIR = join(__dirname, '..', '__fixtures__');
export const raw = (name: string) => readFileSync(join(DIR, `${name}.json`));
export const fixture = <T,>(name: string) => JSON.parse(raw(name).toString('utf8')) as T;
export const STATE_PAUSED = fixture<ReplayState>('state-paused');

type Route = { method: string; path: string; status: number; body: Buffer | string };

// The current test's socket, REST routes and the REST calls the page made
export const page = {
  socket: sockets.current,
  routes: [] as Route[],
  calls: [] as { method: string; url: string; body: unknown }[],
};

export function serve(...r: Route[]) { page.routes = r; }
export const rest = (method: string, path: string, name: string, status: number): Route => ({ method, path, status, body: raw(name) });

class NoResize { observe() { return undefined; } disconnect() { return undefined; } }

export function setupReplayPage() {
  beforeAll(() => { (global as unknown as { ResizeObserver: unknown }).ResizeObserver = NoResize; });
  beforeEach(() => {
    sockets.current = new FakeSocket();
    page.socket = sockets.current;
    mockChart.setData = [];
    mockChart.update = [];
    mockChart.markers = [];
    mockChart.crosshair = null;
    page.routes = [];
    page.calls = [];
    store.dispatch(setCredentials({ accessToken: 'tok', user: { id: 'u1' } as never }));
    store.dispatch(baseApi.util.resetApiState());
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const req = input as Request;
      const text = await req.text();
      page.calls.push({ method: req.method, url: req.url, body: text ? JSON.parse(text) : undefined });
      const route = page.routes.find((r) => r.method === req.method && req.url === `http://localhost/api/replay/sessions${r.path}`);
      return route
        // the recorded bytes as they are (a Uint8Array copy: Node's Buffer type isn't a BodyInit)
        ? new Response(typeof route.body === 'string' ? route.body : new Uint8Array(route.body),
          { status: route.status, headers: { 'Content-Type': 'application/json' } })
        : new Response('{}', { status: 404 });
    });
  });
  afterEach(() => jest.restoreAllMocks());
}

export function renderPage() {
  return render(<Provider store={store}><ReplayClient /></Provider>);
}

// Creates a session from the start form and opens the replay screen on `state`
export async function openScreen(state: unknown = STATE_PAUSED) {
  const socket = page.socket;
  socket.onConnect = () => socket.open(state);
  serve(rest('POST', '', 'create-201', 201));
  const view = renderPage();
  socket.open(fixture('state-no-session'));
  fireEvent.change(screen.getByLabelText('Start date (UTC)'), { target: { value: '2022-03-01' } });
  fireEvent.change(screen.getByLabelText('Start time (UTC)'), { target: { value: '09:30' } });
  fireEvent.click(screen.getByRole('button', { name: 'Start replay' }));
  await screen.findByTestId('replay-badge');
  return view;
}
