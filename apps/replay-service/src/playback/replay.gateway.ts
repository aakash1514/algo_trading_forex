import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit, SubscribeMessage, WebSocketGateway,
} from '@nestjs/websockets';
import type { Namespace, Socket } from 'socket.io';
import { AUTH_EXPIRED_EVENT, REAUTH_EVENT, SocketDeadlines, verifyAccessToken } from '@forexedge/common';
import { PlaybackService, ReplayCommandError } from './playback.service';
import { ReplayEmitter } from './replay-emitter';

export type CommandAck<T> = { ok: true; result: T } | { ok: false; error: string };

// A command's body as the client sent it (validated by PlaybackService)
type CommandBody = { sessionId?: unknown } | undefined;

// Socket.IO namespace /replay (CORS in main.ts's adapter). A socket authenticates with
// the access token in handshake.auth.token and joins room user:<id>: a user only ever
// receives their own session. On connect it gets the full state, always PAUSED.
// Commands answer through the acknowledgement: { ok: true, result } or { ok: false, error }.
// The socket is held to its access token's expiry: before it, the client sends REAUTH_EVENT with a
// refreshed access token of the same user, which moves the deadline. Without one, the socket gets
// AUTH_EXPIRED_EVENT and is disconnected, which pauses a playing replay (DISCONNECT).
@WebSocketGateway({ namespace: '/replay' })
export class ReplayGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(ReplayGateway.name);
  private readonly deadlines = new SocketDeadlines();

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
    const verified = this.verify(socket.handshake.auth?.['token']);
    if (!verified) {
      socket.emit('replayError', { error: 'Unauthorized' });
      socket.disconnect(true);
      return;
    }
    const userId = verified.userId;
    socket.data.userId = userId;
    this.holdUntil(socket, verified.expiresAtMs);
    await socket.join(`user:${userId}`);
    try {
      // this socket has joined the room: more than one means another tab or window
      const otherSockets = (await this.emitter.socketCount(userId)) > 1;
      const state = await this.playback.connected(userId, otherSockets);
      if (socket.connected) socket.emit('state', state ?? { session: null });
    } catch (err) {
      this.logger.error(`Replay state for user ${userId} failed: ${err instanceof Error ? err.message : err}`);
      socket.emit('replayError', { error: 'Could not load the replay session' });
    }
  }

  async handleDisconnect(socket: Socket): Promise<void> {
    this.deadlines.clear(socket.id);
    const userId = socket.data.userId as string | undefined;
    if (!userId) return;
    if ((await this.emitter.socketCount(userId)) === 0) {
      await this.playback.lastSocketLeft(userId).catch((err) =>
        this.logger.error(`Pausing user ${userId} on disconnect failed: ${err instanceof Error ? err.message : err}`));
    }
  }

  // A refreshed access token for this socket's user: the deadline moves to its expiry. Anything else
  // (invalid, expired, a refresh token, another user's token) is refused and the old deadline stays.
  @SubscribeMessage(REAUTH_EVENT)
  reauth(@ConnectedSocket() socket: Socket, @MessageBody() body: { token?: unknown } | undefined): CommandAck<{ expiresAt: string }> {
    const userId = socket.data.userId as string | undefined;
    const verified = this.verify(body?.token);
    if (!userId || !verified || verified.userId !== userId) {
      this.logger.warn(`Reauth refused on socket ${socket.id}`);
      return { ok: false, error: 'Unauthorized' };
    }
    this.holdUntil(socket, verified.expiresAtMs);
    return { ok: true, result: { expiresAt: new Date(verified.expiresAtMs).toISOString() } };
  }

  // Every command names its session: { sessionId, ... }
  @SubscribeMessage('play')
  play(@ConnectedSocket() socket: Socket, @MessageBody() body: CommandBody) {
    return this.command(socket, (userId) => this.playback.play(userId, body?.sessionId));
  }

  @SubscribeMessage('pause')
  pause(@ConnectedSocket() socket: Socket, @MessageBody() body: CommandBody) {
    return this.command(socket, (userId) => this.playback.pause(userId, body?.sessionId));
  }

  @SubscribeMessage('step')
  step(@ConnectedSocket() socket: Socket, @MessageBody() body: CommandBody) {
    return this.command(socket, (userId) => this.playback.step(userId, body?.sessionId));
  }

  @SubscribeMessage('setSpeed')
  setSpeed(@ConnectedSocket() socket: Socket, @MessageBody() body: CommandBody & { speedMs?: unknown }) {
    return this.command(socket, (userId) => this.playback.setSpeed(userId, body?.sessionId, body?.speedMs));
  }

  @SubscribeMessage('setTimeframe')
  setTimeframe(@ConnectedSocket() socket: Socket, @MessageBody() body: CommandBody & { timeframe?: unknown }) {
    return this.command(socket, (userId) => this.playback.setTimeframe(userId, body?.sessionId, body?.timeframe));
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

  // The user and expiry of a valid access token (the REST guard's algorithm, issuer and audience), or null
  private verify(token: unknown) {
    return verifyAccessToken(this.jwt, token, this.config.getOrThrow<string>('JWT_ACCESS_SECRET'));
  }

  private holdUntil(socket: Socket, expiresAtMs: number): void {
    this.deadlines.schedule(socket.id, expiresAtMs, () => {
      socket.emit(AUTH_EXPIRED_EVENT);
      socket.disconnect(true);
    });
  }
}
