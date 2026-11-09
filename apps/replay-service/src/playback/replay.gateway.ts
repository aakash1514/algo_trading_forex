import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit, SubscribeMessage, WebSocketGateway,
} from '@nestjs/websockets';
import type { Namespace, Socket } from 'socket.io';
import { assertUserId } from '@forexedge/common';
import { PlaybackService, ReplayCommandError } from './playback.service';
import { ReplayEmitter } from './replay-emitter';

export type CommandAck<T> = { ok: true; result: T } | { ok: false; error: string };

// Socket.IO namespace /replay (CORS in main.ts's adapter). A socket authenticates with
// the access token in handshake.auth.token and joins room user:<id>: a user only ever
// receives their own session. On connect it gets the full state, always PAUSED.
// Commands answer through the acknowledgement: { ok: true, result } or { ok: false, error }.
@WebSocketGateway({ namespace: '/replay' })
export class ReplayGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(ReplayGateway.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly playback: PlaybackService,
    private readonly emitter: ReplayEmitter,
  ) {}

  afterInit(namespace: Namespace): void {
    this.emitter.attach(namespace);
  }

  async handleConnection(socket: Socket): Promise<void> {
    const userId = this.authenticate(socket);
    if (!userId) {
      socket.emit('replayError', { error: 'Unauthorized' });
      socket.disconnect(true);
      return;
    }
    socket.data.userId = userId;
    await socket.join(`user:${userId}`);
    try {
      const state = await this.playback.connected(userId);
      if (socket.connected) socket.emit('state', state ?? { session: null });
    } catch (err) {
      this.logger.error(`Replay state for user ${userId} failed: ${err instanceof Error ? err.message : err}`);
      socket.emit('replayError', { error: 'Could not load the replay session' });
    }
  }

  async handleDisconnect(socket: Socket): Promise<void> {
    const userId = socket.data.userId as string | undefined;
    if (!userId) return;
    if ((await this.emitter.socketCount(userId)) === 0) {
      await this.playback.lastSocketLeft(userId).catch((err) =>
        this.logger.error(`Pausing user ${userId} on disconnect failed: ${err instanceof Error ? err.message : err}`));
    }
  }

  @SubscribeMessage('play')
  play(@ConnectedSocket() socket: Socket) {
    return this.command(socket, (userId) => this.playback.play(userId));
  }

  @SubscribeMessage('pause')
  pause(@ConnectedSocket() socket: Socket) {
    return this.command(socket, (userId) => this.playback.pause(userId));
  }

  @SubscribeMessage('step')
  step(@ConnectedSocket() socket: Socket) {
    return this.command(socket, (userId) => this.playback.step(userId));
  }

  @SubscribeMessage('setSpeed')
  setSpeed(@ConnectedSocket() socket: Socket, @MessageBody() body: { speedMs?: unknown } | undefined) {
    return this.command(socket, (userId) => this.playback.setSpeed(userId, body?.speedMs));
  }

  @SubscribeMessage('setTimeframe')
  setTimeframe(@ConnectedSocket() socket: Socket, @MessageBody() body: { timeframe?: unknown } | undefined) {
    return this.command(socket, (userId) => this.playback.setTimeframe(userId, body?.timeframe));
  }

  private async command<T>(socket: Socket, run: (userId: string) => Promise<T>): Promise<CommandAck<T>> {
    const userId = socket.data.userId as string | undefined;
    if (!userId) return { ok: false, error: 'Unauthorized' };
    try {
      return { ok: true, result: await run(userId) };
    } catch (err) {
      if (err instanceof ReplayCommandError) return { ok: false, error: err.message };
      this.logger.error(`Replay command failed for user ${userId}: ${err instanceof Error ? err.stack : err}`);
      return { ok: false, error: 'Replay command failed' };
    }
  }

  // The user id from a valid access token, or null
  private authenticate(socket: Socket): string | null {
    const token = socket.handshake.auth?.['token'];
    if (typeof token !== 'string' || token === '') return null;
    try {
      const payload = this.jwt.verify<{ sub?: string }>(token, { secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET') });
      assertUserId(payload.sub); // a token without a subject would share room user:undefined
      return payload.sub as string;
    } catch {
      return null;
    }
  }
}
