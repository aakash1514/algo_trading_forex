/** @jest-environment ./test/jsdom-with-fetch.cjs */
import { readFileSync } from 'fs';
import { join } from 'path';
import { createRef } from 'react';
import { act, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { store } from '../../store';
import { baseApi } from '../../store/api/base.api';
import { replayReset, stateReceived } from '../../store/slices/replay.slice';
import type { ReplayState } from '../../types/replay.types';
import { ReplayOrderPanel, type OrderPanelHandle } from './ReplayOrderPanel';

// The handle the B/S shortcuts use: it only chooses the side and focuses Lots; it never
// sends an order (fetch would be the only way out, and it must stay unused).

const STATE_PAUSED = JSON.parse(readFileSync(join(__dirname, '__fixtures__', 'state-paused.json'), 'utf8')) as ReplayState;

let fetchSpy: jest.SpyInstance;
beforeEach(() => {
  store.dispatch(baseApi.util.resetApiState());
  store.dispatch(replayReset());
  store.dispatch(stateReceived(STATE_PAUSED));
  fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async () => new Response('{}', { status: 500 }));
});
afterEach(() => jest.restoreAllMocks());

function renderPanel() {
  const ref = createRef<OrderPanelHandle>();
  render(<Provider store={store}><ReplayOrderPanel ref={ref} /></Provider>);
  return ref;
}

const pressed = (name: string) => screen.getByRole('button', { name }).getAttribute('aria-pressed');

describe('order panel prepare(side)', () => {
  it.each([['SELL', 'Sell', 'Buy', 'Sell 0.10 lots'], ['BUY', 'Buy', 'Sell', 'Buy 0.10 lots']] as const)(
    'prepare(%s) preselects %s and puts the cursor in Lots, not on the submit button', async (side, on, off, submit) => {
      const ref = renderPanel();
      if (side === 'BUY') act(() => ref.current?.prepare('SELL')); // start from the other side
      act(() => ref.current?.prepare(side));
      expect(pressed(on)).toBe('true');
      expect(pressed(off)).toBe('false');
      expect(document.activeElement).toBe(screen.getByLabelText('Lots'));
      expect(document.activeElement).not.toBe(screen.getByRole('button', { name: submit }));
      await act(async () => undefined);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(screen.queryByRole('status')).toBeNull(); // no "Order placed"
    });

  it('the Buy and Sell buttons show their keys', () => {
    renderPanel();
    expect(screen.getByRole('button', { name: 'Buy' }).title).toBe('Buy (B)');
    expect(screen.getByRole('button', { name: 'Sell' }).title).toBe('Sell (S)');
  });
});
