import {
  Controller, Get, Post, UseGuards, Request, HttpCode, HttpStatus,
} from '@nestjs/common';
import { AccountService } from './account.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('account')
@UseGuards(JwtAuthGuard)
export class AccountController {
  constructor(private readonly accountService: AccountService) {}

  // GET /api/account/summary
  @Get('summary')
  async getSummary(@Request() req: any) {
    return this.accountService.getAccountSummary(req.user.id);
  }

  // POST /api/account/initialize
  @Post('initialize')
  @HttpCode(HttpStatus.CREATED)
  async initialize(@Request() req: any) {
    return this.accountService.initializeAccount(req.user.id);
  }
}