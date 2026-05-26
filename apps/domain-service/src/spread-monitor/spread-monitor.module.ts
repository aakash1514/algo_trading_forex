import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InstrumentEntity } from '@forexedge/database';
import { SpreadMonitorService } from './spread-monitor.service';

@Module({
  imports: [TypeOrmModule.forFeature([InstrumentEntity])],
  providers: [SpreadMonitorService],
  exports: [SpreadMonitorService],
})
export class SpreadMonitorModule {}