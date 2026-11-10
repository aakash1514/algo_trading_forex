import { JwtService } from '@nestjs/jwt';
import { ACCESS_TOKEN_SIGN_OPTIONS, REFRESH_TOKEN_SIGN_OPTIONS } from './jwt-claims';
import { SocketDeadlines, verifyAccessToken } from './socket-auth';

const SECRET = 'test-access-secret-long-enough-for-hs256';
const jwt = new JwtService();

describe('verifyAccessToken', () => {
  it('returns the user and expiry of an access token', () => {
    const token = jwt.sign({ sub: 'u1' }, { ...ACCESS_TOKEN_SIGN_OPTIONS, secret: SECRET, expiresIn: 60 });
    const { exp } = jwt.decode(token) as { exp: number };
    expect(verifyAccessToken(jwt, token, SECRET)).toEqual({ userId: 'u1', expiresAtMs: exp * 1000 });
  });

  it.each([
    ['a refresh token', jwt.sign({ sub: 'u1' }, { ...REFRESH_TOKEN_SIGN_OPTIONS, secret: SECRET, expiresIn: 60 })],
    ['a token without exp', jwt.sign({ sub: 'u1' }, { ...ACCESS_TOKEN_SIGN_OPTIONS, secret: SECRET })],
    ['a token without sub', jwt.sign({ role: 'TRADER' }, { ...ACCESS_TOKEN_SIGN_OPTIONS, secret: SECRET, expiresIn: 60 })],
    ['a wrong secret', jwt.sign({ sub: 'u1' }, { ...ACCESS_TOKEN_SIGN_OPTIONS, secret: 'another-secret-long-enough', expiresIn: 60 })],
    ['not a token', 'abc'],
    ['an empty string', ''],
    ['a number', 42],
  ])('refuses %s', (_label, token) => {
    expect(verifyAccessToken(jwt, token, SECRET)).toBeNull();
  });
});

describe('SocketDeadlines', () => {
  beforeEach(() => jest.useFakeTimers({ now: 0 }));
  afterEach(() => jest.useRealTimers());

  it('fires once at the deadline; rescheduling replaces the old deadline', () => {
    const deadlines = new SocketDeadlines();
    const fired = jest.fn();
    deadlines.schedule('s', 1_000, fired);
    deadlines.schedule('s', 5_000, fired);
    jest.advanceTimersByTime(4_999);
    expect(fired).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(fired).toHaveBeenCalledTimes(1);
    expect(deadlines.size).toBe(0);
  });

  it('a past deadline fires at once; clear() cancels', () => {
    const deadlines = new SocketDeadlines();
    const past = jest.fn();
    deadlines.schedule('a', -1, past);
    expect(past).toHaveBeenCalledTimes(1);
    const cleared = jest.fn();
    deadlines.schedule('b', 1_000, cleared);
    deadlines.clear('b');
    jest.advanceTimersByTime(10_000);
    expect(cleared).not.toHaveBeenCalled();
  });

  it('reaches a deadline beyond setTimeout\'s 24.8-day limit without firing early', () => {
    const deadlines = new SocketDeadlines();
    const fired = jest.fn();
    const thirtyDays = 30 * 86_400_000;
    deadlines.schedule('s', thirtyDays, fired);
    jest.advanceTimersByTime(2 ** 31 - 1);
    expect(fired).not.toHaveBeenCalled();
    jest.advanceTimersByTime(thirtyDays - (2 ** 31 - 1));
    expect(fired).toHaveBeenCalledTimes(1);
  });
});
