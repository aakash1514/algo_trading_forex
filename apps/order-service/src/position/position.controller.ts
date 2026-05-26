import {
  Controller, Get, Delete, Param, UseGuards, Request,
} from '@nestjs/common';
import { PositionService } from './position.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('positions')
@UseGuards(JwtAuthGuard)
export class PositionController {
  constructor(private readonly positionService: PositionService) {}

  // GET /api/positions
  @Get()
  async getOpenPositions(@Request() req: any) {
    return this.positionService.getOpenPositions(req.user.userId);
  }

  // GET /api/positions/:id
  @Get(':id')
  async getPosition(@Request() req: any, @Param('id') id: string) {
    return this.positionService.getPosition(req.user.userId, id);
  }

  // DELETE /api/positions/:id — manual close
  @Delete(':id')
  async closePosition(@Request() req: any, @Param('id') id: string) {
    // Fetch current price from position record as closing price
    const position = await this.positionService.getPosition(req.user.userId, id);
    return this.positionService.closePosition(
      id,
      'MANUAL',
      Number(position.currentPrice ?? position.openPrice),
    );
  }
}