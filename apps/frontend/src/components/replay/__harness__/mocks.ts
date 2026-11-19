import { act } from '@testing-library/react';

// The two edges a Replay page spec replaces, in a module that imports neither the app nor
// the libraries it stands in for, so the specs' jest.mock factories can require it:
//   jest.mock('lightweight-charts', () => jest.requireActual('./__harness__/mocks').chartLibrary);
//   jest.mock('socket.io-client', () => ({ io: () => jest.requireActual('./__harness__/mocks').sockets.current }));

export const mockChart = { setData: [] as unknown[][], update: [] as { time: number; close: number }[] };

export const chartLibrary = {
  CandlestickSeries: {},
  ColorType: { Solid: 'solid' },
  createChart: () => ({
    addSeries: () => ({
      setData: (d: unknown[]) => mockChart.setData.push(d),
      update: (b: { time: number; close: number }) => mockChart.update.push(b),
      applyOptions: () => undefined,
    }),
    applyOptions: () => undefined,
    remove: () => undefined,
    timeScale: () => ({ setVisibleLogicalRange: () => undefined }),
  }),
};

type Handler = (payload?: unknown) => void;
export class FakeSocket {
  handlers = new Map<string, Handler[]>();
  connected = false;
  active = true;
  sent: { name: string; body: unknown; resolve: (ack: unknown) => void }[] = [];
  connects = 0;
  onConnect: (() => void) | null = null;
  io = { on: () => undefined, removeAllListeners: () => undefined };
  on(event: string, h: Handler) { this.handlers.set(event, [...(this.handlers.get(event) ?? []), h]); return this; }
  removeAllListeners() { this.handlers.clear(); return this; }
  connect() { this.connects += 1; this.onConnect?.(); return this; }
  disconnect() { this.connected = false; return this; }
  timeout() {
    return { emitWithAck: (name: string, body: unknown) => new Promise((resolve) => this.sent.push({ name, body, resolve })) };
  }
  // what replay-service sends
  serve(event: string, payload?: unknown) { act(() => { for (const h of this.handlers.get(event) ?? []) h(payload); }); }
  open(state: unknown) { this.connected = true; this.serve('connect'); this.serve('state', state); }
}

// The socket io() hands out; a fresh one per test (setupReplayPage)
export const sockets = { current: new FakeSocket() };
