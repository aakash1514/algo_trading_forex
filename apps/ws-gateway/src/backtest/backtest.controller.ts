import {
  Controller,
  Post,
  Get,
  Delete,
  Param,
  Body,
  Req,
  Res,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { BacktestService } from './backtest.service';
import { SubmitBacktestDto } from './dto/submit-backtest.dto';

interface AuthenticatedRequest extends Request {
  user: { id: string; email: string; role: string };
}

@Controller('backtest')
@UseGuards(JwtAuthGuard)  // all endpoints require JWT — per-controller pattern
export class BacktestController {
  constructor(private readonly backtestService: BacktestService) {}

  // POST /api/backtest/run — submit backtest, returns 202 immediately
  @Post('run')
  @HttpCode(HttpStatus.ACCEPTED)
  async submit(
    @Req() req: AuthenticatedRequest,
    @Body() dto: SubmitBacktestDto,
  ) {
    return this.backtestService.submit(req.user.id, dto);
  }

  // GET /api/backtest — list user's runs
  @Get()
  async list(@Req() req: AuthenticatedRequest) {
    return this.backtestService.list(req.user.id);
  }

  // GET /api/backtest/:runId — status + summary metrics
  @Get(':runId')
  async findOne(
    @Req() req: AuthenticatedRequest,
    @Param('runId') runId: string,
  ) {
    return this.backtestService.findOne(runId, req.user.id);
  }

  // GET /api/backtest/:runId/results — the run's results.json, read from the store (MinIO or S3) by
  // ws-gateway after the owner check. The bucket is never exposed to the browser (no presigned URL).
  @Get(':runId/results')
  async getResults(
    @Req() req: AuthenticatedRequest,
    @Param('runId') runId: string,
    @Res() res: Response,
  ) {
    const body = await this.backtestService.getResults(runId, req.user.id);
    res.type('application/json').send(body);
  }

  // DELETE /api/backtest/:runId — cancel queued job
  @Delete(':runId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async cancel(
    @Req() req: AuthenticatedRequest,
    @Param('runId') runId: string,
  ) {
    return this.backtestService.cancel(runId, req.user.id);
  }
}