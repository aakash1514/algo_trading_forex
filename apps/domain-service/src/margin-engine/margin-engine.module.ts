import { Module } from '@nestjs/common';
import { MarginEngineService } from './margin-engine.service';
import { PipCalculatorModule } from '../pip-calculator/pip-calculator.module';

@Module({
  imports: [PipCalculatorModule],
  providers: [MarginEngineService],
  exports: [MarginEngineService],
})
export class MarginEngineModule {}