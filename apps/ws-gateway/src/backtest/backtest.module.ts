import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BacktestRunEntity } from '@forexedge/database';
import { GatewayModule } from '../gateway/gateway.module';
import { BacktestQueueModule } from './backtest-queue.module';
import { BacktestWorker } from './backtest.worker';
import { BacktestController } from './backtest.controller';
import { BacktestService } from './backtest.service';
import { StrategyRegistry } from './strategies/strategy.registry';
import { BACKTEST_RESULT_STORE, BacktestResultStore, resultStoreConfig } from './result-store';

@Module({
  imports: [
    TypeOrmModule.forFeature([BacktestRunEntity]),
    GatewayModule,
    BacktestQueueModule,
  ],
  providers: [
    BacktestWorker,
    BacktestService,
    StrategyRegistry,
    // STORAGE (minio | s3) and its settings are read here, at startup: a bad value fails it
    { provide: BACKTEST_RESULT_STORE, useFactory: () => BacktestResultStore.fromConfig(resultStoreConfig()) },
  ],
  controllers: [BacktestController],
  exports: [BACKTEST_RESULT_STORE],
})
export class BacktestModule {}