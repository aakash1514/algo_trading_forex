import { Module, Global, Logger } from '@nestjs/common';
import Redis from 'ioredis';

export const REDIS_CLIENT = 'REDIS_CLIENT';
const logger = new Logger('RedisModule');

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: () => {
        const client = new Redis({
          host: process.env.REDIS_HOST ?? 'localhost',
          port: Number(process.env.REDIS_PORT ?? 6379),
          password: process.env.REDIS_PASS ?? undefined,
          lazyConnect: false,
        });

        client.on('connect', () => logger.log('Redis connected'));
        client.on('error', (err) => logger.error('Redis error', err));

        return client;
      },
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}