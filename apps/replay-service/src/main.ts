import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';
import { configureApp } from './app/configure-app';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  const port = process.env.REPLAY_SERVICE_PORT || 3008;
  await app.listen(port);
  Logger.log(`🚀 Replay Service running on http://localhost:${port}/api`);
}

bootstrap();
