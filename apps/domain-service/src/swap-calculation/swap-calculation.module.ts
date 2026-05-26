import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SwapCalculationService } from './swap-calculation.service';
import { InstrumentEntity, SwapRateEntity } from '@forexedge/database';

@Module({
  imports: [TypeOrmModule.forFeature([InstrumentEntity, SwapRateEntity])],
  providers: [SwapCalculationService],
  exports: [SwapCalculationService],
})
export class SwapCalculationModule {}