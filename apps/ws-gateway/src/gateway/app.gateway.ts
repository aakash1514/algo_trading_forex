import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Logger, OnModuleDestroy } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { AUTH_EXPIRED_EVENT, SocketDeadlines, verifyAccessToken } from '@forexedge/common';
import { SOCKET_EVENTS } from '@forexedge/kafka';
import { FeedStatusService } from './feed-status.service';

// How often every socket gets feed:status (the dot), besides once on connect
export const FEED_STATUS_INTERVAL_MS = 5_000;

// CORS comes from the SocketIoAdapter in main.ts (CORS_ORIGIN), not from this decorator
@WebSocketGateway()
export class AppGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(AppGateway.name);

  // instrument → Set<socketId>
  // Tracks which sockets subscribed to which currency pair ticks
  private tickSubscriptions = new Map<string, Set<string>>();

  private feedTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly jwtService: JwtService,
    private readonly feedStatus: FeedStatusService,
  ) {}

  afterInit(): void {
    this.feedTimer = setInterval(() => this.server.emit(SOCKET_EVENTS.FEED_STATUS, this.feedStatus.status()), FEED_STATUS_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    clearInterval(this.feedTimer);
  }

  // One deadline per socket: the access token's expiry (see @forexedge/common socket-auth)
  private readonly deadlines = new SocketDeadlines();

  // ── Connection handler — JWT auth on handshake, held to the token's expiry ──
  // When the token expires the socket gets AUTH_EXPIRED_EVENT and is disconnected; the client
  // refreshes its token and reconnects (useForexSocket).
  async handleConnection(socket: Socket) {
    const verified = verifyAccessToken(this.jwtService, socket.handshake.auth?.token, process.env.JWT_ACCESS_SECRET ?? '');
    if (!verified) {
      this.logger.warn(`Socket ${socket.id} rejected — missing, invalid or expired token`);
      socket.disconnect(true);
      return;
    }
    socket.data.userId = verified.userId;
    socket.join(`user:${verified.userId}`);
    this.deadlines.schedule(socket.id, verified.expiresAtMs, () => {
      socket.emit(AUTH_EXPIRED_EVENT);
      socket.disconnect(true);
    });
    socket.emit(SOCKET_EVENTS.FEED_STATUS, this.feedStatus.status());
    this.logger.log(`Socket ${socket.id} connected — user:${verified.userId}`);
  }

  // ── Disconnect handler — clean up ALL tickSubscription entries ──
  handleDisconnect(socket: Socket) {
    this.deadlines.clear(socket.id);
    this.tickSubscriptions.forEach((socketIds, instrument) => {
      socketIds.delete(socket.id);
      // Remove instrument key entirely if no subscribers remain — prevents Map bloat
      if (socketIds.size === 0) {
        this.tickSubscriptions.delete(instrument);
      }
    });
    this.logger.log(`Socket ${socket.id} disconnected`);
  }

  // ── Tick subscription ──
  @SubscribeMessage('subscribe:ticker')
  handleSubscribe(
    @ConnectedSocket() socket: Socket,
    @MessageBody() instrument: string,
  ) {
    if (!this.tickSubscriptions.has(instrument)) {
      this.tickSubscriptions.set(instrument, new Set());
    }
    this.tickSubscriptions.get(instrument)!.add(socket.id);
    this.logger.debug(`Socket ${socket.id} subscribed to ${instrument}`);
  }

  @SubscribeMessage('unsubscribe:ticker')
  handleUnsubscribe(
    @ConnectedSocket() socket: Socket,
    @MessageBody() instrument: string,
  ) {
    this.tickSubscriptions.get(instrument)?.delete(socket.id);
    this.logger.debug(`Socket ${socket.id} unsubscribed from ${instrument}`);
  }

  // ── Methods called by Kafka consumers ──

  emitToUser(userId: string, event: string, payload: unknown) {
    if (typeof userId !== 'string' || userId.trim() === '') {
      this.logger.warn(`Dropped ${event}: no target user id`);
      return;
    }
    this.server.to(`user:${userId}`).emit(event, payload);
  }

  emitTick(instrument: string, payload: unknown) {
    const subscribers = this.tickSubscriptions.get(instrument);
    if (!subscribers || subscribers.size === 0) return; // no one watching, skip
    subscribers.forEach((socketId) => {
      this.server.to(socketId).emit(`tick:${instrument}`, payload);
    });
  }
}