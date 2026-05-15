import { Module, Global, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export const REDIS_CLIENT = 'REDIS_CLIENT';

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const redis = new Redis({
          host: config.get<string>('REDIS_HOST'),
          port: config.get<number>('REDIS_PORT'),
          password: config.get<string>('REDIS_PASS'),
          lazyConnect: false,
          retryStrategy: (times) => {
            if (times > 3) {
              console.error('Redis connection failed after 3 retries');
              return null; // stop retrying
            }
            return Math.min(times * 500, 2000);
          },
          reconnectOnError: () => true,
        });

        redis.on('connect', () => {
          console.log('✅ Redis connected');
        });

        redis.on('error', (err) => {
          console.error('❌ Redis error:', err.message);
          // Don't throw — let retryStrategy handle it
        });

        return redis;
      },
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}