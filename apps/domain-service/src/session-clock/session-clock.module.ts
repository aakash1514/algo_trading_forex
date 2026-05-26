import { Module } from '@nestjs/common';
import { SessionClockService } from './session-clock.service';

@Module({
  providers: [SessionClockService],
  exports: [SessionClockService],
})
export class SessionClockModule {}