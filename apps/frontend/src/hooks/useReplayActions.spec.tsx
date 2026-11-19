import { readFileSync } from 'fs';
import { join } from 'path';
import type { ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { Provider } from 'react-redux';
import { store } from '../store';
import { connectionChanged, replayReset, stateReceived } from '../store/slices/replay.slice';
import type { CommandAck, ReplayState, StepResult } from '../types/replay.types';
import type { ReplayCommand, ReplaySocket } from './useReplaySocket';
import { STEP_MANY_BARS, useReplayActions } from './useReplayActions';

// The 10-bar step against a stub socket that keeps answering whatever happens to the page,
// so only useReplayActions' own checks can stop the run.

const STATE_PAUSED = JSON.parse(readFileSync(
  join(__dirname, '..', 'components', 'replay', '__fixtures__', 'state-paused.json'), 'utf8')) as ReplayState;

// replay-service's acknowledgement of a 'step', on the recorded paused session
const stepAck = (endOfData: boolean): CommandAck<StepResult> =>
  ({ ok: true, result: { session: STATE_PAUSED.session, minutes: 1, endOfData } });

let sent: { name: ReplayCommand; answer: (ack: CommandAck) => void }[];
const socket: ReplaySocket = {
  command: (name) => new Promise((resolve) => { sent.push({ name, answer: resolve }); }),
  resync: () => undefined,
  retry: () => undefined,
};

const wrapper = ({ children }: { children: ReactNode }) => <Provider store={store}>{children}</Provider>;

beforeEach(() => {
  sent = [];
  store.dispatch(replayReset());
  store.dispatch(stateReceived(STATE_PAUSED));
  store.dispatch(connectionChanged('connected'));
});

async function answer(i: number, ack: CommandAck) {
  await act(async () => { sent[i].answer(ack); });
}

describe('step 10 bars', () => {
  it('sends 10 single steps, each only after the previous acknowledgement', async () => {
    const { result } = renderHook(() => useReplayActions(socket), { wrapper });
    let run!: Promise<void>;
    act(() => { run = result.current.stepMany(); });
    expect(result.current.steppingMany).toBe(true);
    expect(result.current.canStep).toBe(false); // the buttons and keys wait for the run
    for (let i = 0; i < STEP_MANY_BARS; i += 1) {
      expect(sent).toHaveLength(i + 1); // one in flight at a time
      await answer(i, stepAck(false));
    }
    await act(async () => run);
    expect(sent.map((s) => s.name)).toEqual(Array(10).fill('step'));
    expect(result.current.steppingMany).toBe(false);
  });

  it('stops at the end of the data', async () => {
    const { result } = renderHook(() => useReplayActions(socket), { wrapper });
    act(() => { void result.current.stepMany(); });
    await answer(0, stepAck(false));
    await answer(1, stepAck(false));
    await answer(2, stepAck(true));
    expect(sent).toHaveLength(3);
    expect(result.current.steppingMany).toBe(false);
  });

  it('stops at a refused step', async () => {
    const { result } = renderHook(() => useReplayActions(socket), { wrapper });
    act(() => { void result.current.stepMany(); });
    await answer(0, stepAck(false));
    await answer(1, { ok: false, error: 'Replay command failed' });
    expect(sent).toHaveLength(2);
    expect(result.current.steppingMany).toBe(false);
  });

  it('stops when the connection drops mid-run', async () => {
    const { result } = renderHook(() => useReplayActions(socket), { wrapper });
    act(() => { void result.current.stepMany(); });
    await answer(0, stepAck(false));
    act(() => { store.dispatch(connectionChanged('reconnecting')); });
    await answer(1, stepAck(false));
    expect(sent).toHaveLength(2);
  });

  it('stops when the replay screen unmounts mid-run: nothing is sent after the unmount', async () => {
    const { result, unmount } = renderHook(() => useReplayActions(socket), { wrapper });
    act(() => { void result.current.stepMany(); });
    await answer(0, stepAck(false));
    await answer(1, stepAck(false));
    expect(sent).toHaveLength(3);
    unmount();
    await answer(2, stepAck(false)); // the step in flight is acknowledged after the unmount
    await act(async () => undefined);
    expect(sent).toHaveLength(3);
  });

  it('a second start while running sends nothing more', async () => {
    const { result } = renderHook(() => useReplayActions(socket), { wrapper });
    act(() => { void result.current.stepMany(); void result.current.stepMany(); });
    expect(sent).toHaveLength(1);
  });
});
