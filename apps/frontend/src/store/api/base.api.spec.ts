/** @jest-environment node */
import type { BaseQueryApi } from '@reduxjs/toolkit/query';
import { store } from '../index';
import { setCredentials, clearCredentials } from '../slices/auth.slice';
import { baseQueryWithReauth } from './base.api';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const queryApi = () => ({
  dispatch: store.dispatch,
  getState: store.getState,
  signal: new AbortController().signal,
  abort: jest.fn(),
  extra: undefined,
  endpoint: 'test',
  type: 'query',
}) as unknown as BaseQueryApi;

const authHeader = (call: unknown[]) => (call[0] as Request).headers.get('Authorization');
const urlOf = (call: unknown[]) => (call[0] instanceof Request ? call[0].url : String(call[0]));

describe('baseQueryWithReauth', () => {
  beforeEach(() => {
    store.dispatch(setCredentials({ accessToken: 'expired', user: { id: 'u1' } as never }));
  });
  afterEach(() => jest.restoreAllMocks());

  it('stores the refreshed token before retrying, and the retry uses it', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith('/auth/refresh')) return json(200, { accessToken: 'fresh', user: { id: 'u1' } });
      const auth = (input as Request).headers.get('Authorization');
      return auth === 'Bearer fresh' ? json(200, { ok: true }) : json(401, { message: 'Unauthorized' });
    });

    const result = await baseQueryWithReauth('http://localhost:3004/api/positions', queryApi(), {});

    expect(result.data).toEqual({ ok: true });
    expect(store.getState().auth.accessToken).toBe('fresh');
    const apiCalls = fetchSpy.mock.calls.filter((c) => urlOf(c).endsWith('/positions'));
    expect(apiCalls.map(authHeader)).toEqual(['Bearer expired', 'Bearer fresh']);
  });

  it('makes concurrent 401s share one refresh call', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith('/auth/refresh')) {
        await new Promise((r) => setTimeout(r, 20));
        return json(200, { accessToken: 'fresh', user: { id: 'u1' } });
      }
      const auth = (input as Request).headers.get('Authorization');
      return auth === 'Bearer fresh' ? json(200, { ok: true }) : json(401, {});
    });

    const results = await Promise.all([
      baseQueryWithReauth('http://localhost:3004/api/positions', queryApi(), {}),
      baseQueryWithReauth('http://localhost:3004/api/account/summary', queryApi(), {}),
      baseQueryWithReauth('http://localhost:3004/api/orders', queryApi(), {}),
    ]);

    expect(results.every((r) => r.data)).toBe(true);
    expect(fetchSpy.mock.calls.filter((c) => urlOf(c).endsWith('/auth/refresh'))).toHaveLength(1);
  });

  it('clears credentials when the refresh fails', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      return url.endsWith('/auth/refresh') ? json(403, {}) : json(401, {});
    });

    await baseQueryWithReauth('http://localhost:3004/api/positions', queryApi(), {});
    expect(store.getState().auth).toMatchObject({ isAuthenticated: false, accessToken: null, sessionRestored: true });
  });

  it('does not try to refresh on a failed login', async () => {
    store.dispatch(clearCredentials());
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(json(401, { message: 'Invalid credentials' }));
    await baseQueryWithReauth({ url: 'http://localhost:3000/api/auth/login', method: 'POST', body: {} }, queryApi(), {});
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
