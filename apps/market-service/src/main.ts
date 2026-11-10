import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';
import { HEALTH_ROUTES } from '@forexedge/common';

const CORS_ORIGIN = ['http://localhost:4200', 'http://localhost:3001'];

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: CORS_ORIGIN,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Idempotency-Key'],
  });
  app.setGlobalPrefix('api', { exclude: HEALTH_ROUTES }); // /health/live and /health/ready
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  const port = process.env.PORT ?? 3002;
  await app.listen(port);
  Logger.log(`🚀 Market Service running on http://localhost:${port}/api`);
}

bootstrap();