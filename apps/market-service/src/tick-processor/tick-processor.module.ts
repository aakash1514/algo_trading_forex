import { Module } from '@nestjs/common';
import { TickDbWriterService } from './tick-db-writer.service';
import { TickCacheWriterService } from './tick-cache-writer.service';

@Module({
  providers: [TickDbWriterService, TickCacheWriterService],
})
export class TickProcessorModule {}