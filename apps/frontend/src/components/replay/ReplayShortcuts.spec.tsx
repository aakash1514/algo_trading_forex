/** @jest-environment ./test/jsdom-with-fetch.cjs */
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import type { CommandAck, ReplaySession, ReplayState, StepResult } from '../../types/replay.types';
import { fixture, openScreen, page, rest, serve, setupReplayPage, STATE_PAUSED } from './__harness__/page';

// The Replay page's keyboard shortcuts through the real page, store and socket hook
// (__harness__/page.tsx): what each key sends to replay-service, or must not send.

jest.mock('lightweight-charts', () => jest.requireActual('./__harness__/mocks').chartLibrary);
jest.mock('socket.io-client', () => ({ io: () => jest.requireActual('./__harness__/mocks').sockets.current }));

setupReplayPage();

// A keydown as the browser sends it; false when the page called preventDefault
const press = (key: string, init: KeyboardEventInit = {}, target: Element = document.body) =>
  fireEvent.keyDown(target, { key, ...init });

const sentNames = () => page.socket.sent.map((s) => s.name);
const ok: CommandAck = { ok: true, result: {} };
// replay-service's acknowledgement of a 'step', on the recorded paused session
const stepAck = (endOfData = false): CommandAck<StepResult> =>
  ({ ok: true, result: { session: STATE_PAUSED.session, minutes: 1, endOfData } });
async function acknowledge(i: number, ack: CommandAck = ok) {
  await act(async () => page.socket.sent[i].resolve(ack));
}
// The recorded session with a changed field, as replay-service's 'status' event carries it
const status = (change: Partial<ReplaySession>) => page.socket.serve('status', { ...STATE_PAUSED.session, ...change });
const createOnly = () => page.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/sessions'));

describe('replay shortcuts: playback', () => {
  it('Space plays when paused and pauses when playing, with no page scroll', async () => {
    await openScreen();
    expect(press(' ')).toBe(false); // handled: preventDefault
    expect(sentNames()).toEqual(['play']);
    await acknowledge(0);
    status({ status: 'PLAYING' });
    press(' ');
    expect(sentNames()).toEqual(['play', 'pause']);
  });

  it('→ steps one bar while paused', async () => {
    await openScreen();
    expect(press('ArrowRight')).toBe(false);
    expect(page.socket.sent).toEqual([expect.objectContaining({ name: 'step', body: { sessionId: STATE_PAUSED.session.id } })]);
  });

  it('Shift+→ steps 10 bars, one after another, like the Step 10 button', async () => {
    await openScreen();
    expect(press('ArrowRight', { shiftKey: true })).toBe(false);
    for (let i = 0; i < 10; i += 1) {
      expect(page.socket.sent).toHaveLength(i + 1);
      await acknowledge(i, stepAck());
    }
    await act(async () => undefined);
    expect(sentNames()).toEqual(Array(10).fill('step'));
  });

  it('Shift+→ stops early at the end of the data', async () => {
    await openScreen();
    press('ArrowRight', { shiftKey: true });
    await acknowledge(0, stepAck());
    await acknowledge(1, stepAck(true));
    await act(async () => undefined);
    expect(sentNames()).toEqual(['step', 'step']);
  });

  it('→ and Shift+→ do nothing while playing (and are not swallowed)', async () => {
    await openScreen();
    status({ status: 'PLAYING' });
    expect(press('ArrowRight')).toBe(true);
    expect(press('ArrowRight', { shiftKey: true })).toBe(true);
    expect(page.socket.sent).toEqual([]);
  });

  it('↑ sets the next faster speed, ↓ the next slower one, from the middle speed (1 s)', async () => {
    await openScreen();
    expect(STATE_PAUSED.session.speedMs).toBe(1000);
    press('ArrowUp');
    expect(page.socket.sent[0]).toMatchObject({ name: 'setSpeed', body: { speedMs: 500 } });
    await acknowledge(0);
    press('ArrowDown');
    expect(page.socket.sent[1]).toMatchObject({ name: 'setSpeed', body: { speedMs: 2000 } });
  });

  it('↑ at the fastest speed and ↓ at the slowest send nothing', async () => {
    const fastest = fixture<ReplayState>('state-closed-trades');
    expect(fastest.session.speedMs).toBe(500);
    await openScreen(fastest);
    expect(press('ArrowUp')).toBe(true);
    expect(page.socket.sent).toEqual([]);
    status({ id: fastest.session.id, speedMs: 2000 });
    expect(press('ArrowDown')).toBe(true);
    expect(page.socket.sent).toEqual([]);
  });

  it('holding a key (auto-repeat) sends nothing more than the first press', async () => {
    await openScreen();
    press('ArrowRight');
    await acknowledge(0);
    expect(press('ArrowRight', { repeat: true })).toBe(true);
    expect(press(' ', { repeat: true })).toBe(true);
    expect(sentNames()).toEqual(['step']);
  });

  it('nothing while a command waits for its acknowledgement', async () => {
    await openScreen();
    press('ArrowRight');
    expect(press('ArrowRight')).toBe(true);
    expect(press(' ')).toBe(true);
    expect(press('ArrowUp')).toBe(true);
    expect(sentNames()).toEqual(['step']);
  });

  it('nothing while the connection is down', async () => {
    await openScreen();
    page.socket.connected = false;
    page.socket.serve('disconnect', 'transport close');
    for (const key of [' ', 'ArrowRight', 'ArrowUp', 'b']) expect(press(key)).toBe(true);
    expect(page.socket.sent).toEqual([]);
  });

  it('nothing once the session has ended (summary shown) or after leaving the page', async () => {
    const view = await openScreen(fixture('state-closed-trades'));
    page.socket.serve('ended', fixture('ended'));
    await screen.findByTestId('replay-summary');
    for (const key of [' ', 'ArrowRight', 'ArrowDown', '?']) expect(press(key)).toBe(true);
    view.unmount();
    expect(press(' ')).toBe(true);
    expect(page.socket.sent).toEqual([]);
  });

  it('Space on a focused button is the button’s own click only: one toggle, not two', async () => {
    await openScreen();
    const play = screen.getByTestId('replay-play');
    play.focus();
    expect(press(' ', {}, play)).toBe(true); // left to the browser, which clicks it on key up
    fireEvent.click(play);
    expect(sentNames()).toEqual(['play']);
  });
});

describe('replay shortcuts: typing and the order form', () => {
  it('keys typed in Lots stay in Lots: no step, no play', async () => {
    await openScreen();
    const lots = screen.getByLabelText('Lots');
    for (const key of ['1', ' ', 'ArrowRight', 'ArrowUp', 'b', '?']) expect(press(key, {}, lots)).toBe(true);
    expect(page.socket.sent).toEqual([]);
    expect(screen.queryByTestId('replay-shortcuts-help')).toBeNull();
  });

  it.each([['b', 'Buy', 'Sell'], ['S', 'Sell', 'Buy']])(
    '%s chooses %s and puts the cursor in Lots; it never places an order', async (key, on, off) => {
      await openScreen();
      if (on === 'Buy') fireEvent.click(screen.getByRole('button', { name: 'Sell' })); // start from the other side
      expect(press(key)).toBe(false); // the letter is not typed into Lots
      expect(screen.getByRole('button', { name: on }).getAttribute('aria-pressed')).toBe('true');
      expect(screen.getByRole('button', { name: off }).getAttribute('aria-pressed')).toBe('false');
      expect(document.activeElement).toBe(screen.getByLabelText('Lots'));
      expect((document.activeElement as HTMLElement).getAttribute('type')).not.toBe('submit');
      await act(async () => undefined);
      expect(page.calls).toEqual(createOnly()); // no order request
      expect(page.socket.sent).toEqual([]);
    });
});

describe('replay shortcuts: help and Esc', () => {
  it('? shows and hides the shortcuts panel; Esc closes it', async () => {
    await openScreen();
    const button = screen.getByTestId('replay-shortcuts');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(press('?', { shiftKey: true })).toBe(false);
    expect(screen.getByTestId('replay-shortcuts-help').textContent).toContain('Step 10 bars');
    expect(button.getAttribute('aria-expanded')).toBe('true');
    press('?', { shiftKey: true });
    expect(screen.queryByTestId('replay-shortcuts-help')).toBeNull();
    fireEvent.click(button); // the button does the same
    expect(screen.getByTestId('replay-shortcuts-help')).toBeTruthy();
    press('Escape');
    expect(screen.queryByTestId('replay-shortcuts-help')).toBeNull();
    expect(page.socket.sent).toEqual([]);
  });

  it('Esc cancels the End-session question and never ends the session; other keys wait while it is open', async () => {
    await openScreen();
    serve(rest('POST', `/${STATE_PAUSED.session.id}/end`, 'end-200', 200));
    fireEvent.click(screen.getByRole('button', { name: 'End session' }));
    expect(screen.getByTestId('replay-end-confirm')).toBeTruthy();
    for (const key of [' ', 'ArrowRight', 'b']) expect(press(key)).toBe(true);
    press('Escape');
    expect(screen.queryByTestId('replay-end-confirm')).toBeNull();
    await act(async () => undefined);
    expect(page.calls.some((c) => c.url.endsWith('/end'))).toBe(false);
    expect(page.socket.sent).toEqual([]);
    await waitFor(() => expect(screen.getByRole('button', { name: 'End session' })).toBeTruthy());
  });
});

describe('replay shortcuts: buttons show their keys', () => {
  it('play, step, step 10, speeds and the shortcuts button', async () => {
    await openScreen();
    expect(screen.getByTestId('replay-play').title).toBe('Play (Space)');
    expect(screen.getByTestId('replay-step').title).toBe('Step 1 bar (→)');
    expect(screen.getByTestId('replay-step-many').title).toBe('Step 10 bars (Shift+→)');
    expect(screen.getByRole('button', { name: '0.5 s' }).title).toBe('0.5 s per bar (↑ faster, ↓ slower)');
    expect(screen.getByTestId('replay-shortcuts').title).toBe('Keyboard shortcuts (?)');
    status({ status: 'PLAYING' });
    expect(screen.getByTestId('replay-play').title).toBe('Pause (Space)');
  });
});
