import { Module, Global } from '@nestjs/common';
import { Queue } from 'bullmq';

export const BACKTEST_QUEUE = 'BACKTEST_QUEUE';

@Global()
@Module({
  providers: [
    {
      provide: BACKTEST_QUEUE,
      useFactory: () => {
        return new Queue('backtest', {
          connection: {
            host: process.env.REDIS_HOST ?? 'localhost',
            port: Number(process.env.REDIS_PORT ?? 6379),
            password: process.env.REDIS_PASS ?? undefined,
          },
          defaultJobOptions: {
            attempts: 2,
            backoff: { type: 'exponential', delay: 3000 },
            removeOnComplete: 100,  // keep last 100 completed jobs in Redis
            removeOnFail: 50,       // keep last 50 failed jobs for debugging
          },
        });
      },
    },
  ],
  exports: [BACKTEST_QUEUE],
})
export class BacktestQueueModule {}