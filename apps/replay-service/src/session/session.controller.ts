import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PlaybackService } from '../playback/playback.service';
import { ReplayEmitter } from '../playback/replay-emitter';
import { CreateSessionDto } from './dto/create-session.dto';
import { ReplaySessionService } from './session.service';
import { ReplayTradesService } from './trades.service';

interface AuthenticatedRequest extends Request {
  user: { id: string; email: string; role: string };
}

@Controller('replay/sessions')
@UseGuards(JwtAuthGuard)
export class ReplaySessionController {
  constructor(
    private readonly sessions: ReplaySessionService,
    private readonly playback: PlaybackService,
    private readonly emitter: ReplayEmitter,
    private readonly trades: ReplayTradesService,
  ) {}

  // POST /api/replay/sessions — 201, or 409 { activeSessionId } while one is active
  @Post()
  create(@Req() req: AuthenticatedRequest, @Body() dto: CreateSessionDto) {
    return this.sessions.create(req.user.id, dto);
  }

  // GET /api/replay/sessions/active — 404 when there is none
  @Get('active')
  getActive(@Req() req: AuthenticatedRequest) {
    return this.sessions.getActive(req.user.id);
  }

  // POST /api/replay/sessions/active/end — closes open positions at the clock price
  // (its timer stops and the user's sockets get 'ended')
  @Post('active/end')
  @HttpCode(HttpStatus.OK)
  async end(@Req() req: AuthenticatedRequest) {
    const ended = await this.sessions.end(req.user.id);
    this.playback.forget(ended.session.id);
    this.emitter.toUser(req.user.id, 'ended', ended, new Date(ended.session.clockTime));
    return ended;
  }

  // GET /api/replay/sessions/:id/trades[?cursor=] — closed trades, newest first, 20 a page;
  // 404 for a session that isn't the user's
  @Get(':id/trades')
  closedTrades(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string, @Query('cursor') cursor?: string) {
    return this.trades.closedTrades(req.user.id, id, cursor);
  }

  // GET /api/replay/sessions/:id/stats — from every closed trade of the session
  @Get(':id/stats')
  stats(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.trades.stats(req.user.id, id);
  }
}
