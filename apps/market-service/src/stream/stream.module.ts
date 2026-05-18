import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StreamService } from './stream.service';
import { MockStreamProvider } from './providers/mock-stream.provider';
import { OandaStreamProvider } from './providers/oanda-stream.provider';
import { STREAM_PROVIDER } from './interfaces/stream-provider.interface';
import { MarketModule } from '../market/market.module';

@Module({
  imports: [MarketModule],
  providers: [
    // This is the dependency inversion in action.
    // NestJS reads USE_MOCK_DATA from env and injects the correct provider.
    // StreamService never knows which one it gets — it only sees IForexStreamProvider.
    {
      provide: STREAM_PROVIDER,
      useFactory: (config: ConfigService) => {
        const useMock = config.get<string>('USE_MOCK_DATA', 'true') === 'true';
        if (useMock) {
          return new MockStreamProvider();
        }
        return new OandaStreamProvider(config);
      },
      inject: [ConfigService],
    },
    StreamService,
  ],
})
export class StreamModule {}