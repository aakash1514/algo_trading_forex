import { INestApplication, ValidationPipe } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions } from 'socket.io';
import { HEALTH_ROUTES, corsOrigins } from '@forexedge/common';

// replay-service's Socket.IO path: under its own /api/replay prefix, so one origin (Caddy in production,
// next dev's rewrites in development) routes it here while /socket.io goes to ws-gateway. The /replay
// namespace is unchanged; clients connect to <origin>/replay with this path.
export const REPLAY_SOCKET_PATH = '/api/replay/socket.io';

// Socket.IO CORS and path for the /replay namespace (as in ws-gateway, not enableCors)
class SocketIoAdapter extends IoAdapter {
  constructor(app: INestApplication, private readonly origins: string[]) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions) {
    return super.createIOServer(port, {
      ...options,
      cors: { origin: this.origins, credentials: true, methods: ['GET', 'POST'] },
      path: REPLAY_SOCKET_PATH,
    });
  }
}

// HTTP and socket setup shared by main.ts and the in-process app of the tests
export function configureApp(app: INestApplication): void {
  const CORS_ORIGIN = corsOrigins(); // CORS_ORIGIN from the env, required in production
  app.enableCors({
    origin: CORS_ORIGIN,
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });
  app.setGlobalPrefix('api', { exclude: HEALTH_ROUTES }); // /health/live and /health/ready
  app.useWebSocketAdapter(new SocketIoAdapter(app, CORS_ORIGIN));
  app.enableShutdownHooks(); // pauses PLAYING sessions on a clean stop
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
}
