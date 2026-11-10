import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Socket } from 'socket.io';
import { ACCESS_TOKEN_SIGN_OPTIONS, REFRESH_TOKEN_SIGN_OPTIONS } from '@forexedge/common';
import { ReplayGateway } from './replay.gateway';
import type { PlaybackService } from './playback.service';
import type { ReplayEmitter } from './replay-emitter';

// Token expiry on an open /replay socket, with real signed tokens and a fake clock. The socket-level
// behaviour (a real disconnect pausing a playing session) is in guarantees/lifecycle.db.spec.ts.

const SECRET = 'test-access-secret-long-enough-for-hs256';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const T0 = Date.UTC(2026, 10, 10, 12, 0, 0);

const jwt = new JwtService();
const sign = (sub: string, expiresInS: number, options: object = ACCESS_TOKEN_SIGN_OPTIONS, secret = SECRET) =>
  jwt.sign({ sub, email: 'a@b.c', role: 'TRADER' }, { ...options, secret, expiresIn: expiresInS });

function fakeSocket(token: string) {
  return {
    id: `sock-${Math.random()}`,
    handshake: { auth: { token } },
    data: {} as Record<string, unknown>,
    connected: true,
    join: jest.fn().mockResolvedValue(undefined),
    emit: jest.fn(),
    disconnect: jest.fn(),
  } as unknown as Socket & { emit: jest.Mock; disconnect: jest.Mock };
}

function gateway() {
  const config = { getOrThrow: () => SECRET } as unknown as ConfigService;
  const playback = { connected: jest.fn().mockResolvedValue(null), lastSocketLeft: jest.fn() } as unknown as PlaybackService;
  const emitter = { socketCount: jest.fn().mockResolvedValue(1), attach: jest.fn() } as unknown as ReplayEmitter;
  return new ReplayGateway(jwt, config, playback, emitter);
}

const expired = (s: { emit: jest.Mock; disconnect: jest.Mock }) =>
  s.emit.mock.calls.some(([event]) => event === 'authExpired') && s.disconnect.mock.calls.length > 0;

describe('ReplayGateway token expiry and reauth', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
  });
  afterEach(() => jest.useRealTimers());

  it('disconnects the socket with authExpired when its token expires', async () => {
    const g = gateway();
    const s = fakeSocket(sign(USER, 60));
    await g.handleConnection(s);
    jest.advanceTimersByTime(59_000);
    expect(expired(s)).toBe(false);
    jest.advanceTimersByTime(1_000);
    expect(s.emit).toHaveBeenCalledWith('authExpired');
    expect(s.disconnect).toHaveBeenCalledWith(true);
  });

  it('a valid reauth by the same user moves the deadline to the new token', async () => {
    const g = gateway();
    const s = fakeSocket(sign(USER, 60));
    await g.handleConnection(s);
    jest.advanceTimersByTime(50_000);
    const ack = g.reauth(s, { token: sign(USER, 900) });
    expect(ack).toEqual({ ok: true, result: { expiresAt: new Date(T0 + 950_000).toISOString() } });
    jest.advanceTimersByTime(20_000); // past the first token's expiry
    expect(expired(s)).toBe(false);
    jest.advanceTimersByTime(880_000); // the new token's expiry
    expect(expired(s)).toBe(true);
  });

  it.each([
    ['another user\'s token', () => sign(OTHER, 900)],
    ['an expired token', () => sign(USER, -1)],
    ['a forged token (wrong secret)', () => sign(USER, 900, ACCESS_TOKEN_SIGN_OPTIONS, 'not-the-secret-but-long-enough')],
    ['a refresh token', () => sign(USER, 900, REFRESH_TOKEN_SIGN_OPTIONS)],
    ['a token from another issuer', () => sign(USER, 900, { ...ACCESS_TOKEN_SIGN_OPTIONS, issuer: 'someone-else' })],
    ['a token signed with another algorithm', () => sign(USER, 900, { ...ACCESS_TOKEN_SIGN_OPTIONS, algorithm: 'HS512' })],
    ['no token', () => undefined],
  ])('refuses %s and still disconnects at the old deadline', async (_label, token) => {
    const g = gateway();
    const s = fakeSocket(sign(USER, 60));
    await g.handleConnection(s);
    jest.advanceTimersByTime(30_000);
    expect(g.reauth(s, { token: token() })).toEqual({ ok: false, error: 'Unauthorized' });
    jest.advanceTimersByTime(30_000);
    expect(expired(s)).toBe(true);
  });

  it.each([
    ['a refresh token', () => sign(USER, 900, REFRESH_TOKEN_SIGN_OPTIONS)],
    ['an expired token', () => sign(USER, -1)],
    ['a token without an audience', () => sign(USER, 900, { algorithm: 'HS256', issuer: 'forexedge-auth' })],
  ])('refuses %s at the handshake', async (_label, token) => {
    const g = gateway();
    const s = fakeSocket(token());
    await g.handleConnection(s);
    expect(s.emit).toHaveBeenCalledWith('replayError', { error: 'Unauthorized' });
    expect(s.disconnect).toHaveBeenCalledWith(true);
    expect(s.data['userId']).toBeUndefined();
  });

  it('a socket that disconnects first leaves no timer behind', async () => {
    const g = gateway();
    const s = fakeSocket(sign(USER, 60));
    await g.handleConnection(s);
    await g.handleDisconnect(s);
    jest.advanceTimersByTime(120_000);
    expect(s.emit).not.toHaveBeenCalledWith('authExpired');
    expect(jest.getTimerCount()).toBe(0);
  });
});
