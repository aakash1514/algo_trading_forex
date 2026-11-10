/** @jest-environment ./test/jsdom-with-fetch.cjs */
import { store } from '../index';
import { setCredentials } from '../slices/auth.slice';
import { researchApi } from './research.api';
import { ASK_TIMEOUT_MS, askErrorKind } from '../../lib/research';

const ASK_URL = 'http://localhost/api/research/ask';
const status = (code: number) => new Response('{}', { status: code, headers: { 'Content-Type': 'application/json' } });
const askCalls = (spy: jest.SpyInstance) =>
  spy.mock.calls.filter((c) => (c[0] instanceof Request ? c[0].url : String(c[0])) === ASK_URL);

async function ask(question: string) {
  const req = store.dispatch(researchApi.endpoints.askResearch.initiate({ question }));
  const result = await req;
  req.reset();
  return result;
}

describe('askResearch', () => {
  // fetchBaseQuery's timeout timer outlives a fast response; fake timers keep it out of the worker
  beforeEach(() => {
    jest.useFakeTimers();
    store.dispatch(setCredentials({ accessToken: 'tok', user: { id: 'u1' } as never }));
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('POSTs the question once to the research agent with the bearer token', async () => {
    const spy = jest.spyOn(global, 'fetch').mockResolvedValue(status(500));
    await ask('What was EUR/USD return in 2022?');
    const calls = askCalls(spy);
    expect(calls).toHaveLength(1);
    const req = calls[0][0] as Request;
    expect(req.method).toBe('POST');
    expect(req.headers.get('Authorization')).toBe('Bearer tok');
    expect(await req.json()).toEqual({ question: 'What was EUR/USD return in 2022?' });
  });

  it.each([429, 503, 500, 502])('does not retry after a %i', async (code) => {
    const spy = jest.spyOn(global, 'fetch').mockResolvedValue(status(code));
    const result = await ask('Which pair moved most in 2020?');
    expect(askCalls(spy)).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect('error' in result && result.error).toMatchObject({ status: code });
  });

  it('does not retry after a network error', async () => {
    const spy = jest.spyOn(global, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    const result = await ask('Which pair moved most in 2020?');
    expect(spy).toHaveBeenCalledTimes(1);
    expect('error' in result && askErrorKind(result.error)).toBe('network');
  });

  it(`gives up after ${ASK_TIMEOUT_MS} ms, once, as a timeout`, async () => {
    const spy = jest.spyOn(global, 'fetch').mockImplementation(
      (input) =>
        new Promise((_, reject) => {
          // like the real fetch: an aborted request rejects with the signal's reason
          const { signal } = input as Request;
          signal.addEventListener('abort', () => reject(signal.reason));
        }),
    );
    let settled = false;
    const pending = ask('Which pair moved most in 2020?').then((r) => {
      settled = true;
      return r;
    });
    await jest.advanceTimersByTimeAsync(ASK_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(spy).toHaveBeenCalledTimes(1);
    expect('error' in result && result.error).toMatchObject({ status: 'TIMEOUT_ERROR' });
    expect('error' in result && askErrorKind(result.error)).toBe('busy');
  });
});
