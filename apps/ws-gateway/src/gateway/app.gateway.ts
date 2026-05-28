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

  // ── Connection handler — JWT auth on handshake ──
  // Known limitation: token expiry mid-session not enforced.
  // Client reconnects on server restart with a fresh token at that point.
  async handleConnection(socket: Socket) {
    const token = socket.handshake.auth?.token as string | undefined;

    if (!token) {
      this.logger.warn(`Socket ${socket.id} rejected — no token`);
      socket.disconnect(true);
      return;
    }

    try {
      const payload = this.jwtService.verify<{ sub: string; email: string; role: string }>(
        token,
        { secret: process.env.JWT_ACCESS_SECRET },
      );
      socket.data.userId = payload.sub;
      socket.join(`user:${payload.sub}`);
      this.logger.log(`Socket ${socket.id} connected — user:${payload.sub}`);
    } catch {
      this.logger.warn(`Socket ${socket.id} rejected — invalid/expired token`);
      socket.disconnect(true);
    }
  }

  // ── Disconnect handler — clean up ALL tickSubscription entries ──
  handleDisconnect(socket: Socket) {
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