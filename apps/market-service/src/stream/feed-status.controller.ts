import { Controller, Get } from '@nestjs/common';
import { StreamService } from './stream.service';
import type { FeedStatus } from './feed-status';

@Controller('market/feed')
export class FeedStatusController {
  constructor(private readonly stream: StreamService) {}

  // GET /api/market/feed/status: which feed runs, whether its prices are simulated, and its state
  @Get('status')
  getStatus(): FeedStatus {
    return this.stream.getStatus();
  }
}
