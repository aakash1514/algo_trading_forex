import {
  Body, Controller, Get, Delete, Param, Patch, UseGuards, Request,
} from '@nestjs/common';
import { PositionService } from './position.service';
import { UpdateExitLevelsDto } from './dto/update-exit-levels.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('positions')
@UseGuards(JwtAuthGuard)
export class PositionController {
  constructor(private readonly positionService: PositionService) {}

  // GET /api/positions
  @Get()
  async getOpenPositions(@Request() req: any) {
    return this.positionService.getOpenPositions(req.user.id);
  }

  // GET /api/positions/:id
  @Get(':id')
  async getPosition(@Request() req: any, @Param('id') id: string) {
    return this.positionService.getPosition(req.user.id, id);
  }

  // PATCH /api/positions/:id — set or clear stop-loss / take-profit
  // (allowed while the market is closed)
  @Patch(':id')
  async updateExitLevels(@Request() req: any, @Param('id') id: string, @Body() body: UpdateExitLevelsDto) {
    // Only the fields the client sent: absent = keep, null = clear
    const changes: { stopLoss?: number | null; takeProfit?: number | null } = {};
    if (body.stopLoss !== undefined) changes.stopLoss = body.stopLoss;
    if (body.takeProfit !== undefined) changes.takeProfit = body.takeProfit;
    return this.positionService.updateExitLevels(req.user.id, id, changes);
  }

  // DELETE /api/positions/:id — manual close (rejected while the market is closed)
  @Delete(':id')
  async closePosition(@Request() req: any, @Param('id') id: string) {
    return this.positionService.closeAtMarket(req.user.id, id);
  }
}