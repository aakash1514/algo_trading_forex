import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { Queue } from 'bullmq';
import cookieParser from 'cookie-parser';
import { AppModule } from './app/app.module';
import { BACKTEST_QUEUE } from './backtest/backtest-queue.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // ── 1. Bull Board — get queue from DI (not `new Queue()`) ──
  const backtestQueue = app.get<Queue>(BACKTEST_QUEUE);
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath('/admin/queues');
  createBullBoard({
    queues: [new BullMQAdapter(backtestQueue)],
    serverAdapter,
  });
  app.use('/admin/queues', serverAdapter.getRouter());

  // ── 2. Standard middleware + pipes ──
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );

  // ── 3. Socket.io adapter — after HTTP middleware ──
  app.useWebSocketAdapter(new IoAdapter(app));

  // ── 4. Global prefix — excludes Bull Board ──
  app.setGlobalPrefix('api', {
  exclude: ['/admin/queues', '/admin/queues/*path'],  // ← named parameter syntax
});

  await app.listen(3005);
  console.log('ws-gateway        → http://localhost:3005');
  console.log('Bull Board admin  → http://localhost:3005/admin/queues');
}

bootstrap();