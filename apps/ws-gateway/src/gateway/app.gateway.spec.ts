import type { JwtService } from '@nestjs/jwt';
import type { Socket } from 'socket.io';
import { AppGateway } from './app.gateway';

const socket = (token?: string) => ({
  id: 'sock-1',
  handshake: { auth: token ? { token } : {} },
  data: {} as Record<string, unknown>,
  join: jest.fn(),
  disconnect: jest.fn(),
}) as unknown as Socket & { join: jest.Mock; disconnect: jest.Mock };

describe('AppGateway user rooms', () => {
  it('joins the user room for a valid token', async () => {
    const jwt = { verify: jest.fn().mockReturnValue({ sub: 'user-1', email: 'a@b.c', role: 'TRADER' }) };
    const s = socket('tok');
    await new AppGateway(jwt as unknown as JwtService).handleConnection(s);
    expect(s.join).toHaveBeenCalledWith('user:user-1');
    expect(s.disconnect).not.toHaveBeenCalled();
  });

  it('rejects a token without a subject instead of joining "user:undefined"', async () => {
    const jwt = { verify: jest.fn().mockReturnValue({ email: 'a@b.c', role: 'TRADER' }) };
    const s = socket('tok');
    await new AppGateway(jwt as unknown as JwtService).handleConnection(s);
    expect(s.join).not.toHaveBeenCalled();
    expect(s.disconnect).toHaveBeenCalledWith(true);
  });

  it('never emits to an empty user id', () => {
    const gateway = new AppGateway({} as JwtService);
    const to = jest.fn().mockReturnValue({ emit: jest.fn() });
    (gateway as unknown as { server: { to: jest.Mock } }).server = { to };
    gateway.emitToUser('', 'position:update', {});
    gateway.emitToUser(undefined as unknown as string, 'account:update', {});
    expect(to).not.toHaveBeenCalled();
    gateway.emitToUser('user-1', 'account:update', {});
    expect(to).toHaveBeenCalledWith('user:user-1');
  });
});
