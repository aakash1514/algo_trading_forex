import { Module } from '@nestjs/common';
import { MarketDataService } from './market-data.service';
import { MarketDataController } from './market-data.controller';
import { InstrumentRepository } from './instrument.repository';

@Module({
  controllers: [MarketDataController],
  providers: [MarketDataService, InstrumentRepository],
  exports: [InstrumentRepository],  // StreamModule needs InstrumentRepository
})
export class MarketModule {}