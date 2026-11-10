/** @jest-environment node */
import { refreshSession, tokenExpiresAt } from './session';

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

describe('refreshSession', () => {
  afterEach(() => jest.restoreAllMocks());

  it('shares one in-flight request between concurrent callers (refresh tokens rotate)', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(ok({ accessToken: 't1', user: { id: 'u1' } }));
    const [a, b, c] = await Promise.all([refreshSession(), refreshSession(), refreshSession()]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith('/api/auth/refresh', { method: 'POST', credentials: 'include' });
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

// Two tabs share the refresh cookie, and auth-service rotates it on every use and refuses the old
// one. A fake server with exactly that rule; the cookie is read when a request starts, as a browser
// attaches it. Each tab is its own instance of this module (jest.isolateModules), so only the
// cross-tab lock can keep their refreshes apart.
describe('refreshSession across two tabs', () => {
  type Session = typeof import('./session');
  const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

  class FakeLocks {
    private tail = new Map<string, Promise<unknown>>();
    names: string[] = [];
    request<T>(name: string, callback: () => Promise<T>): Promise<T> {
      this.names.push(name);
      const run = (this.tail.get(name) ?? Promise.resolve()).then(callback);
      this.tail.set(name, run.catch(() => undefined));
      return run;
    }
  }

  function rotatingServer() {
    let cookie = 'refresh-0';
    let issued = 0;
    const statuses: number[] = [];
    jest.spyOn(global, 'fetch').mockImplementation(async () => {
      const presented = cookie; // attached when the request starts
      await new Promise((resolve) => setTimeout(resolve, 5)); // the round trip
      if (presented !== cookie) {
        statuses.push(403);
        return new Response('{}', { status: 403 }); // reuse of a rotated token
      }
      cookie = `refresh-${++issued}`; // Set-Cookie with the new refresh token
      statuses.push(200);
      return ok({ accessToken: `access-${issued}`, user: { id: 'u1' } });
    });
    return { statuses };
  }

  const tab = (): Session => {
    let mod: Session | undefined;
    jest.isolateModules(() => { mod = jest.requireActual('./session') as Session; });
    return mod as Session;
  };

  const setLocks = (locks: FakeLocks | undefined) =>
    Object.defineProperty(globalThis, 'navigator', { value: locks ? { locks } : {}, configurable: true });

  afterEach(() => {
    jest.restoreAllMocks();
    if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator);
  });

  it('with the shared lock, both tabs refresh at the same moment and both succeed', async () => {
    const locks = new FakeLocks();
    setLocks(locks);
    const { statuses } = rotatingServer();
    const [a, b] = await Promise.all([tab().refreshSession(), tab().refreshSession()]);
    expect(statuses).toEqual([200, 200]);
    expect(a?.accessToken).toBe('access-1');
    expect(b?.accessToken).toBe('access-2');
    expect(locks.names).toEqual(['forexedge-auth-refresh', 'forexedge-auth-refresh']);
  });

  it('without it (the control), the second tab presents the rotated cookie and is logged out', async () => {
    setLocks(undefined);
    const { statuses } = rotatingServer();
    const [a, b] = await Promise.all([tab().refreshSession(), tab().refreshSession()]);
    expect(statuses).toEqual([200, 403]);
    expect([a?.accessToken ?? null, b?.accessToken ?? null]).toEqual(['access-1', null]);
  });
});

describe('tokenExpiresAt', () => {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  it('reads exp from the payload in ms', () => {
    expect(tokenExpiresAt(`${b64({ alg: 'HS256' })}.${b64({ sub: 'u', exp: 1_800_000_000 })}.sig`)).toBe(1_800_000_000_000);
  });
  it.each([null, '', 'abc', `x.${b64({ sub: 'u' })}.y`, 'x.%%%.y'])('null for %p', (token) => {
    expect(tokenExpiresAt(token)).toBeNull();
  });
});
