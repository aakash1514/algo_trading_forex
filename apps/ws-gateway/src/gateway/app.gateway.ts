import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { AUTH_EXPIRED_EVENT, SocketDeadlines, verifyAccessToken } from '@forexedge/common';

@WebSocketGateway({
  cors: {
    origin: process.env.FRONTEND_URL ?? 'http://localhost:4200',
    credentials: true,
  },
})
export class AppGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(AppGateway.name);

  // instrument → Set<socketId>
  // Tracks which sockets subscribed to which currency pair ticks
  private tickSubscriptions = new Map<string, Set<string>>();

  constructor(private readonly jwtService: JwtService) {}

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