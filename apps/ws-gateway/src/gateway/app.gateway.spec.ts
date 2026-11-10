import { JwtService } from '@nestjs/jwt';
import type { Socket } from 'socket.io';
import { ACCESS_TOKEN_SIGN_OPTIONS, REFRESH_TOKEN_SIGN_OPTIONS } from '@forexedge/common';
import { AppGateway } from './app.gateway';
import { FeedStatusService } from './feed-status.service';

const SECRET = 'test-access-secret-long-enough-for-hs256';
const jwt = new JwtService();
const sign = (payload: object, expiresIn: number, options: object = ACCESS_TOKEN_SIGN_OPTIONS) =>
  jwt.sign(payload, { ...options, secret: SECRET, expiresIn });

const socket = (token?: string) => ({
  id: 'sock-1',
  handshake: { auth: token ? { token } : {} },
  data: {} as Record<string, unknown>,
  join: jest.fn(),
  emit: jest.fn(),
  disconnect: jest.fn(),
}) as unknown as Socket & { join: jest.Mock; emit: jest.Mock; disconnect: jest.Mock };

describe('AppGateway user rooms', () => {
  const previousSecret = process.env.JWT_ACCESS_SECRET;
  beforeAll(() => (process.env.JWT_ACCESS_SECRET = SECRET));
  afterAll(() => (process.env.JWT_ACCESS_SECRET = previousSecret));
  afterEach(() => jest.useRealTimers());

  it('joins the user room for a valid token', async () => {
    const s = socket(sign({ sub: 'user-1', email: 'a@b.c', role: 'TRADER' }, 900));
    const gateway = new AppGateway(jwt, new FeedStatusService());
    await gateway.handleConnection(s);
    expect(s.join).toHaveBeenCalledWith('user:user-1');
    expect(s.disconnect).not.toHaveBeenCalled();
    // the dot's state right away, not only at the next 5 s broadcast
    expect(s.emit).toHaveBeenCalledWith('feed:status', { state: expect.any(String), lastTickAgeMs: null });
    gateway.handleDisconnect(s);
  });

  it('rejects a token without a subject instead of joining "user:undefined"', async () => {
    const s = socket(sign({ email: 'a@b.c', role: 'TRADER' }, 900));
    await new AppGateway(jwt, new FeedStatusService()).handleConnection(s);
    expect(s.join).not.toHaveBeenCalled();
    expect(s.disconnect).toHaveBeenCalledWith(true);
  });

  it.each([
    ['a refresh token', () => sign({ sub: 'user-1' }, 900, REFRESH_TOKEN_SIGN_OPTIONS)],
    ['an expired token', () => sign({ sub: 'user-1' }, -1)],
    ['a token from another issuer', () => sign({ sub: 'user-1' }, 900, { ...ACCESS_TOKEN_SIGN_OPTIONS, issuer: 'x' })],
  ])('rejects %s at the handshake', async (_label, token) => {
    const s = socket(token());
    await new AppGateway(jwt, new FeedStatusService()).handleConnection(s);
    expect(s.join).not.toHaveBeenCalled();
    expect(s.disconnect).toHaveBeenCalledWith(true);
  });

  it('disconnects the socket with authExpired when its token expires, and not before', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(Date.UTC(2026, 10, 10, 12));
    const s = socket(sign({ sub: 'user-1' }, 60));
    await new AppGateway(jwt, new FeedStatusService()).handleConnection(s);
    jest.advanceTimersByTime(59_000);
    expect(s.disconnect).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1_000);
    expect(s.emit).toHaveBeenCalledWith('authExpired');
    expect(s.disconnect).toHaveBeenCalledWith(true);
  });

  it('a socket that disconnects first leaves no timer behind', async () => {
    jest.useFakeTimers();
    const s = socket(sign({ sub: 'user-1' }, 60));
    const gateway = new AppGateway(jwt, new FeedStatusService());
    await gateway.handleConnection(s);
    gateway.handleDisconnect(s);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('never emits to an empty user id', () => {
    const gateway = new AppGateway(jwt, new FeedStatusService());
    const to = jest.fn().mockReturnValue({ emit: jest.fn() });
    (gateway as unknown as { server: { to: jest.Mock } }).server = { to };
    gateway.emitToUser('', 'position:update', {});
    gateway.emitToUser(undefined as unknown as string, 'account:update', {});
    expect(to).not.toHaveBeenCalled();
    gateway.emitToUser('user-1', 'account:update', {});
    expect(to).toHaveBeenCalledWith('user:user-1');
  });
});
