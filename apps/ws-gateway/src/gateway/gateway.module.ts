import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AppGateway } from './app.gateway';

@Module({
  imports: [AuthModule],  // ← provides JwtService to AppGateway
  providers: [AppGateway],
  exports: [AppGateway],
})
export class GatewayModule {}