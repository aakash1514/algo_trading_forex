/** @jest-environment ./test/jsdom-with-fetch.cjs */
import { readFileSync } from 'fs';
import { join } from 'path';
import { act, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { store } from '../../store';
import { setCredentials } from '../../store/slices/auth.slice';
import { tickReceived, setActivePair } from '../../store/slices/market.slice';
import { baseApi } from '../../store/api/base.api';
import { FeedBanner } from './FeedBanner';
import { PairTabs } from './PairTabs';
import { OrderForm } from './OrderForm';

// The terminal through the real store and RTK Query; only fetch is mocked, answering the feed status
// endpoint with a recorded market-service response (__fixtures__/README.md).
const FIXTURES = join(__dirname, '__fixtures__');
const STATUS_URL = 'http://localhost/api/market/feed/status';
const recordedTick = JSON.parse(readFileSync(join(FIXTURES, 'tick-eurusd-mock.json'), 'utf8'));
const TICK_AT = Date.parse(recordedTick.timestamp);

function serveStatus(file: string) {
  return jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === STATUS_URL) {
      return new Response(readFileSync(join(FIXTURES, file)), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 404 });
  });
}

function terminal() {
  return render(
    <Provider store={store}>
      <FeedBanner />
      <PairTabs />
      <OrderForm />
    </Provider>,
  );
}

describe('trading terminal feed states', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: TICK_AT + 500, doNotFake: ['queueMicrotask'] });
    store.dispatch(setCredentials({ accessToken: 'tok', user: { id: 'u1' } as never }));
    store.dispatch(setActivePair('EUR_USD'));
    store.dispatch(baseApi.util.resetApiState()); // each test gets its own feed status response
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('with no feed (the default): shows the no-feed banner and disables order entry', async () => {
    serveStatus('feed-status-none.json');
    terminal();
    await waitFor(() => expect(screen.getByTestId('feed-banner').textContent)
      .toBe('No live market feed — Try historical Replay →'));
    expect(screen.getByRole('link', { name: 'Try historical Replay →' }).getAttribute('href')).toBe('/replay');
    expect(screen.getByTestId('order-entry-disabled').textContent).toBe('Order entry disabled: No live price for EUR/USD');
    const submit = screen.getByRole('button', { name: /buy$/ }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(screen.queryByTestId('simulated-EUR_USD')).toBeNull();
  });

  it('with the simulated feed: SIMULATED on the pair, paper trades on simulated prices, STALE once old', async () => {
    serveStatus('feed-status-mock.json');
    act(() => {
      store.dispatch(tickReceived({ instrument: 'EUR_USD', tick: recordedTick }));
    });
    terminal();
    await waitFor(() => expect(screen.getByTestId('feed-banner').textContent).toMatch(/^SIMULATED PRICES — not market data/));
    expect(screen.getByTestId('simulated-EUR_USD').textContent).toBe('Simulated');
    expect(screen.queryByTestId('stale-EUR_USD')).toBeNull();
    const submit = screen.getByRole('button', { name: /buy$/ }) as HTMLButtonElement;
    expect(submit.textContent).toBe('Paper trade on simulated prices: buy');
    expect(submit.disabled).toBe(false);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(3_000);
    });
    expect(screen.getByTestId('stale-EUR_USD').textContent).toBe('Stale');
    expect(screen.getByTestId('simulated-EUR_USD')).toBeTruthy(); // still marked simulated
    expect(screen.getByTestId('order-entry-disabled').textContent).toBe('Order entry disabled: Price for EUR/USD is stale');
    expect((screen.getByRole('button', { name: /buy$/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('when market-service is unreachable: warns and disables order entry', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    terminal();
    await waitFor(() => expect(screen.getByTestId('feed-banner').textContent).toMatch(/^Market feed status unavailable/));
    expect(screen.getByTestId('order-entry-disabled').textContent).toBe('Order entry disabled: Market feed status unavailable');
  });
});
