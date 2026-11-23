import { createRef } from 'react';
import { fireEvent, renderHook } from '@testing-library/react';
import type { OrderPanelHandle } from '../components/replay/ReplayOrderPanel';
import type { ReplayActions } from './useReplayActions';
import { useReplayShortcuts, type ReplayShortcutTargets } from './useReplayShortcuts';

// The listener alone, with every action allowed and recorded: which keys reach which
// handler, and which never get past the guards. (What the handlers send is tested
// through the real page in ReplayShortcuts.spec.tsx.)

function allowed(): ReplayActions {
  return {
    ready: true, playing: false, steppingMany: false,
    canPlayPause: true, canStep: true, canChange: true, canFaster: true, canSlower: true,
    playPause: jest.fn(), step: jest.fn(), stepMany: jest.fn(async () => undefined), setSpeed: jest.fn(),
    faster: jest.fn(), slower: jest.fn(), setTimeframe: jest.fn(),
  };
}

let targets: ReplayShortcutTargets;
let prepare: jest.Mock;
function mount(change: Partial<ReplayActions> = {}, helpOpen = false) {
  prepare = jest.fn();
  const orderPanel = createRef<OrderPanelHandle>() as { current: OrderPanelHandle | null };
  orderPanel.current = { prepare };
  targets = { actions: { ...allowed(), ...change }, orderPanel, helpOpen, toggleHelp: jest.fn(), closeHelp: jest.fn() };
  return renderHook(() => useReplayShortcuts(targets));
}

const press = (key: string, init: KeyboardEventInit = {}, target: Element = document.body) =>
  fireEvent.keyDown(target, { key, ...init });

// Every handler a key can reach, by name: the calls made so far
function calls() {
  const a = targets.actions;
  const n = (f: unknown) => (f as jest.Mock).mock.calls.length;
  return {
    playPause: n(a.playPause), step: n(a.step), stepMany: n(a.stepMany), faster: n(a.faster), slower: n(a.slower),
    prepare: n(prepare), toggleHelp: n(targets.toggleHelp), closeHelp: n(targets.closeHelp),
  };
}
const none = { playPause: 0, step: 0, stepMany: 0, faster: 0, slower: 0, prepare: 0, toggleHelp: 0, closeHelp: 0 };
const ALL_KEYS = [' ', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'b', 's', '?'];

afterEach(() => { document.body.innerHTML = ''; });

describe('useReplayShortcuts: keys and handlers', () => {
  it.each([
    [' ', {}, 'playPause'],
    ['ArrowRight', {}, 'step'],
    ['ArrowRight', { shiftKey: true }, 'stepMany'],
    ['ArrowUp', {}, 'faster'],
    ['ArrowDown', {}, 'slower'],
    ['?', { shiftKey: true }, 'toggleHelp'],
  ] as const)('%s %o calls %s once and prevents the default', (key, init, handler) => {
    mount();
    expect(press(key, init)).toBe(false);
    expect(calls()).toEqual({ ...none, [handler]: 1 });
  });

  it.each([['b', 'BUY'], ['B', 'BUY'], ['s', 'SELL'], ['S', 'SELL']])('%s prepares %s on the order form', (key, side) => {
    mount();
    expect(press(key)).toBe(false);
    expect(prepare.mock.calls).toEqual([[side]]);
    expect(calls()).toEqual({ ...none, prepare: 1 });
  });

  it('Esc closes the help panel when it is open, and does nothing else', () => {
    mount({}, true);
    press('Escape');
    expect(calls()).toEqual({ ...none, closeHelp: 1 });
  });

  it('other keys are left alone', () => {
    mount();
    for (const key of ['Enter', 'x', 'ArrowLeft', 'Tab']) expect(press(key)).toBe(true);
    expect(calls()).toEqual(none);
  });
});

describe('useReplayShortcuts: ignored', () => {
  it.each([['ctrlKey'], ['metaKey'], ['altKey']])('with %s held (browser shortcuts)', (modifier) => {
    mount();
    for (const key of ALL_KEYS) expect(press(key, { [modifier]: true })).toBe(true);
    expect(calls()).toEqual(none);
  });

  it('during IME composition and on auto-repeat', () => {
    mount();
    for (const key of ALL_KEYS) {
      expect(press(key, { isComposing: true })).toBe(true);
      expect(press(key, { repeat: true })).toBe(true);
    }
    expect(calls()).toEqual(none);
  });

  it.each([
    ['an input', '<input id="t" />'],
    ['a textarea', '<textarea id="t"></textarea>'],
    ['a select', '<select id="t"><option>1</option></select>'],
    ['a contenteditable element', '<div contenteditable="true"><span id="t">x</span></div>'],
    ['a form', '<form><button id="t" type="button">Buy</button></form>'],
    ['a dialog', '<div role="dialog"><button id="t" type="button">OK</button></div>'],
  ])('while the focus is in %s', (_, html) => {
    mount();
    document.body.innerHTML = html;
    const target = document.getElementById('t') as Element;
    for (const key of ALL_KEYS) expect(press(key, {}, target)).toBe(true);
    expect(calls()).toEqual(none);
  });

  it('Esc still closes the help panel from a field', () => {
    mount({}, true);
    document.body.innerHTML = '<input id="t" />';
    press('Escape', {}, document.getElementById('t') as Element);
    expect(calls()).toEqual({ ...none, closeHelp: 1 });
  });

  it('while a confirmation dialog is open elsewhere on the page', () => {
    mount();
    document.body.innerHTML = '<div role="alertdialog">End the replay?</div>';
    for (const key of ALL_KEYS) expect(press(key)).toBe(true);
    expect(calls()).toEqual(none);
  });

  it('while no command can go out (disconnected, ended, a command in flight)', () => {
    mount({ ready: false });
    for (const key of ALL_KEYS) expect(press(key)).toBe(true);
    expect(calls()).toEqual(none);
  });

  it('when the key’s button is disabled', () => {
    mount({ canPlayPause: false, canStep: false, canFaster: false, canSlower: false });
    for (const key of [' ', 'ArrowRight', 'ArrowUp', 'ArrowDown']) expect(press(key)).toBe(true);
    expect(press('ArrowRight', { shiftKey: true })).toBe(true);
    expect(calls()).toEqual(none);
  });

  it('Space on a focused button (the browser clicks it); arrows still work there', () => {
    mount();
    document.body.innerHTML = '<button id="t" type="button">Play</button>';
    const button = document.getElementById('t') as Element;
    expect(press(' ', {}, button)).toBe(true);
    expect(press('ArrowRight', {}, button)).toBe(false);
    expect(calls()).toEqual({ ...none, step: 1 });
  });

  it('after unmount: the listener is gone', () => {
    const { unmount } = mount();
    unmount();
    for (const key of ALL_KEYS) expect(press(key)).toBe(true);
    expect(calls()).toEqual(none);
  });
});
