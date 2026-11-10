import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';
import { HEALTH_ROUTES, corsOrigins } from '@forexedge/common';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const CORS_ORIGIN = corsOrigins(); // CORS_ORIGIN from the env, required in production
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
  const port = process.env.PORT || 3004;
  await app.listen(port);
  Logger.log(`🚀 Order Service running on http://localhost:${port}/api`);
}

bootstrap();