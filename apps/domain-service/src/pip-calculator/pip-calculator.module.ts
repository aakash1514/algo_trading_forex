import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InstrumentEntity } from '@forexedge/database';
import { PipCalculatorService } from './pip-calculator.service';

@Module({
  imports: [TypeOrmModule.forFeature([InstrumentEntity])],
  providers: [PipCalculatorService],
  exports: [PipCalculatorService],
})
export class PipCalculatorModule {}