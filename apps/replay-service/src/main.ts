import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions } from 'socket.io';
import { AppModule } from './app/app.module';

const CORS_ORIGIN = ['http://localhost:4200', 'http://localhost:3001'];

// Socket.IO CORS for the /replay namespace (as in ws-gateway, not enableCors)
class SocketIoAdapter extends IoAdapter {
  override createIOServer(port: number, options?: ServerOptions) {
    return super.createIOServer(port, {
      ...options,
      cors: { origin: CORS_ORIGIN, credentials: true, methods: ['GET', 'POST'] },
    });
  }
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
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
  const port = process.env.REPLAY_SERVICE_PORT || 3008;
  await app.listen(port);
  Logger.log(`🚀 Replay Service running on http://localhost:${port}/api`);
}

bootstrap();
