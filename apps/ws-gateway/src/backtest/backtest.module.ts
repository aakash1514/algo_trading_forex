import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BacktestRunEntity } from '@forexedge/database';
import { GatewayModule } from '../gateway/gateway.module';
import { BacktestQueueModule } from './backtest-queue.module';
import { BacktestWorker } from './backtest.worker';
import { BacktestController } from './backtest.controller';
import { BacktestService } from './backtest.service';
import { StrategyRegistry } from './strategies/strategy.registry';

@Module({
  imports: [
    TypeOrmModule.forFeature([BacktestRunEntity]),
    GatewayModule,
    BacktestQueueModule,
  ],
  providers: [BacktestWorker, BacktestService, StrategyRegistry],
  controllers: [BacktestController],
})
export class BacktestModule {}