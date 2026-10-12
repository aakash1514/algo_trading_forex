import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HttpModule } from '@nestjs/axios';
import { EconomicCalendarService } from './economic-calendar.service';
import { OfficialCalendarService } from './official-calendar.service';
import { EconomicEventEntity } from '@forexedge/database';

@Module({
  imports: [
    TypeOrmModule.forFeature([EconomicEventEntity]),
    HttpModule,
  ],
  providers: [EconomicCalendarService, OfficialCalendarService],
  exports: [EconomicCalendarService],
})
export class EconomicCalendarModule {}