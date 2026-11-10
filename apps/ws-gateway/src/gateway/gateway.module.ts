import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AppGateway } from './app.gateway';
import { FeedStatusService } from './feed-status.service';

@Module({
  imports: [AuthModule],  // ← provides JwtService to AppGateway
  providers: [AppGateway, FeedStatusService],
  exports: [AppGateway, FeedStatusService],
})
export class GatewayModule {}