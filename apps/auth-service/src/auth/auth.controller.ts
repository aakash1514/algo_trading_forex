import {
  Controller,
  Post,
  Body,
  Res,
  Req,
  UseGuards,
  Get,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Response, Request } from 'express';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { JwtRefreshGuard } from './guards/jwt-refresh.guard';
import { RegistrationOpenGuard } from './guards/registration-open.guard';
import { cookieSecure } from '@forexedge/common';
import { demoRequestUrl } from './demo-request-url';

// The refresh-token cookie. secure from COOKIE_SECURE (default true in production, HTTPS only);
// sameSite lax: the app and its API share one origin, so the cookie never has to travel cross-site,
// and lax still keeps it off cross-site POSTs. clearCookie must repeat the same attributes.
const REFRESH_COOKIE = 'refresh_token';
const REFRESH_COOKIE_PATH = '/api/auth'; // cookie only sent to auth routes

@Controller('auth')
export class AuthController {
  private readonly cookieOptions = {
    httpOnly: true, // JS cannot read this cookie — prevents XSS theft
    secure: cookieSecure(),
    sameSite: 'lax' as const,
    path: REFRESH_COOKIE_PATH,
  };
  // DEMO_REQUEST_URL, read once: an absolute https:// URL or null (anything else dropped with a warning)
  private readonly demoRequestUrl = demoRequestUrl();

  constructor(
    private readonly authService: AuthService,
    private readonly registration: RegistrationOpenGuard,
  ) {}

  // Public: what the login and register pages may offer (read at runtime, so one frontend build
  // serves an open or a closed deployment). demoRequestUrl: where to ask for a demo login, or null.
  @Get('config')
  getConfig() {
    return { registrationEnabled: this.registration.open, demoRequestUrl: this.demoRequestUrl };
  }

  @Post('register')
  @UseGuards(RegistrationOpenGuard)
  async register(@Body() dto: RegisterDto, @Res() res: Response) {
    const result = await this.authService.register(dto);
    this.setRefreshTokenCookie(res, result.refreshToken);
    return res.json({
      accessToken: result.accessToken,
      user: result.user,
    });
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto, @Res() res: Response) {
    const result = await this.authService.login(dto);
    this.setRefreshTokenCookie(res, result.refreshToken);
    return res.json({
      accessToken: result.accessToken,
      user: result.user,
    });
  }

  @Post('refresh')
  @UseGuards(JwtRefreshGuard)
  @HttpCode(HttpStatus.OK)
  async refresh(@Req() req: Request, @Res() res: Response) {
    const user = req.user as any;
    const result = await this.authService.refreshTokens(
      user.sub,
      user.refreshToken,
    );
    this.setRefreshTokenCookie(res, result.refreshToken);
    return res.json({
      accessToken: result.accessToken,
      user: result.user,
    });
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async logout(@Req() req: Request, @Res() res: Response) {
    const user = req.user as any;
    await this.authService.logout(user.id);
    // Must match the attributes the cookie was set with, or the browser keeps it.
    res.clearCookie(REFRESH_COOKIE, this.cookieOptions);
    return res.json({ message: 'Logged out successfully' });
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  getMe(@Req() req: Request) {
    const user = req.user as any;
    const { passwordHash, ...safe } = user;
    return safe;
  }

  // ─── Helper ──────────────────────────────────────────────
  private setRefreshTokenCookie(res: Response, token: string) {
    res.cookie(REFRESH_COOKIE, token, {
      ...this.cookieOptions,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days in milliseconds
    });
  }
}