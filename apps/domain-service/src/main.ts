import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';

const CORS_ORIGIN = ['http://localhost:4200', 'http://localhost:3001'];

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: CORS_ORIGIN,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Idempotency-Key'],
  });
  app.setGlobalPrefix('api');
  const port = process.env.PORT || 3003;
  await app.listen(port);
  Logger.log(`🚀 Domain Service running on http://localhost:${port}/api`);
}

bootstrap();