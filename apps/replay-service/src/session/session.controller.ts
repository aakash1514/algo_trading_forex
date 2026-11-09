import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PlaybackService } from '../playback/playback.service';
import { ReplayEmitter } from '../playback/replay-emitter';
import { CreateSessionDto } from './dto/create-session.dto';
import { ReplaySessionService } from './session.service';

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
}
