/** @jest-environment node */
import { refreshSession } from './session';

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

describe('refreshSession', () => {
  afterEach(() => jest.restoreAllMocks());

  it('shares one in-flight request between concurrent callers (refresh tokens rotate)', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(ok({ accessToken: 't1', user: { id: 'u1' } }));
    const [a, b, c] = await Promise.all([refreshSession(), refreshSession(), refreshSession()]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith('http://localhost:3000/api/auth/refresh', { method: 'POST', credentials: 'include' });
    expect(a).toEqual({ accessToken: 't1', user: { id: 'u1' } });
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('starts a new request once the previous one settled', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async () => ok({ accessToken: 't', user: { id: 'u1' } }));
    await refreshSession();
    await refreshSession();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('resolves null when the cookie is missing or revoked', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 403 }));
    await expect(refreshSession()).resolves.toBeNull();
  });
});
