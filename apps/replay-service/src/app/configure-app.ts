import { INestApplication, ValidationPipe } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions } from 'socket.io';

export const CORS_ORIGIN = ['http://localhost:4200', 'http://localhost:3001'];

// Socket.IO CORS for the /replay namespace (as in ws-gateway, not enableCors)
class SocketIoAdapter extends IoAdapter {
  override createIOServer(port: number, options?: ServerOptions) {
    return super.createIOServer(port, {
      ...options,
      cors: { origin: CORS_ORIGIN, credentials: true, methods: ['GET', 'POST'] },
    });
  }
}

// HTTP and socket setup shared by main.ts and the in-process app of the tests
export function configureApp(app: INestApplication): void {
  app.enableCors({
    origin: CORS_ORIGIN,
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });
  app.setGlobalPrefix('api');
  app.useWebSocketAdapter(new SocketIoAdapter(app));
  app.enableShutdownHooks(); // pauses PLAYING sessions on a clean stop
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
}
