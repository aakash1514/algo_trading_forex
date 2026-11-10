import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions } from 'socket.io';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { Queue } from 'bullmq';
import cookieParser from 'cookie-parser';
import { AppModule } from './app/app.module';
import { BACKTEST_QUEUE } from './backtest/backtest-queue.module';
import { basicAuth, bullBoardCredentials } from './admin/bull-board-auth';
import { HEALTH_ROUTES, corsOrigins } from '@forexedge/common';

// Socket.IO CORS (not enableCors), from the same CORS_ORIGIN setting as the HTTP routes
class SocketIoAdapter extends IoAdapter {
  constructor(app: ConstructorParameters<typeof IoAdapter>[0], private readonly origins: string[]) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions) {
    return super.createIOServer(port, {
      ...options,
      cors: {
        origin: this.origins,
        credentials: true,
        methods: ['GET', 'POST'],
      },
    });
  }
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const CORS_ORIGIN = corsOrigins(); // CORS_ORIGIN from the env, required in production

  app.enableCors({
    origin: CORS_ORIGIN,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Idempotency-Key'],
  });

  // Bull Board exposes every user's jobs: operator-only, behind Basic auth,
  // and not mounted at all unless BULL_BOARD_USER/BULL_BOARD_PASS are set.
  const bullBoardAuth = bullBoardCredentials(process.env);
  if (bullBoardAuth) {
    const backtestQueue = app.get<Queue>(BACKTEST_QUEUE);
    const serverAdapter = new ExpressAdapter();
    serverAdapter.setBasePath('/admin/queues');
    createBullBoard({
      queues: [new BullMQAdapter(backtestQueue)],
      serverAdapter,
    });
    app.use('/admin/queues', basicAuth(bullBoardAuth), serverAdapter.getRouter());
  }

  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );

  app.useWebSocketAdapter(new SocketIoAdapter(app, CORS_ORIGIN));

  app.setGlobalPrefix('api', {
    exclude: ['/admin/queues', '/admin/queues/*path', ...HEALTH_ROUTES],
  });

  await app.listen(3005);
  console.log('ws-gateway        → http://localhost:3005');
  console.log(bullBoardAuth
    ? 'Bull Board admin  → http://localhost:3005/admin/queues (basic auth)'
    : 'Bull Board admin  → disabled (set BULL_BOARD_USER and BULL_BOARD_PASS)');
}

bootstrap();