import {
  Injectable,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as argon2 from 'argon2';
import type { StringValue } from 'ms';
import { InjectRedis } from '../redis/redis.decorator';
import Redis from 'ioredis';
import { UsersService } from '../users/users.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { UserEntity } from '@forexedge/database';
import { JwtPayload } from './strategies/jwt.strategy';
import { hashPassword } from './password-hash';
import { ACCESS_TOKEN_SIGN_OPTIONS, REFRESH_TOKEN_SIGN_OPTIONS } from '@forexedge/common';

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  // ─── Register ────────────────────────────────────────────
  async register(dto: RegisterDto) {
    const passwordHash = await hashPassword(dto.password);

    const user = await this.usersService.create({
      email: dto.email,
      username: dto.username,
      passwordHash,
      firstName: dto.firstName,
      lastName: dto.lastName,
    });

    const tokens = await this.generateTokens(user);
    await this.storeRefreshToken(user.id, tokens.refreshToken);

    return { user: this.sanitizeUser(user), ...tokens };
  }

  // ─── Login ───────────────────────────────────────────────
  async login(dto: LoginDto) {
    const user = await this.usersService.findByEmail(dto.email);
    if (!user) {
      // Same error for wrong email or wrong password
      // Never reveal which one is wrong — prevents user enumeration
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordValid = await argon2.verify(user.passwordHash, dto.password);
    if (!passwordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    await this.usersService.updateLastLogin(user.id);
    const tokens = await this.generateTokens(user);
    await this.storeRefreshToken(user.id, tokens.refreshToken);

    return { user: this.sanitizeUser(user), ...tokens };
  }

  // ─── Refresh tokens ──────────────────────────────────────
  async refreshTokens(userId: string, refreshToken: string) {
    // Verify this refresh token is in Redis (not revoked)
    const storedToken = await this.redis.get(`refresh:${userId}`);
    if (!storedToken || storedToken !== refreshToken) {
      throw new ForbiddenException('Refresh token invalid or expired');
    }

    const user = await this.usersService.findById(userId);
    if (!user) {
      throw new ForbiddenException('User not found');
    }

    // Rotate: delete old, issue new pair
    await this.redis.del(`refresh:${userId}`);
    const tokens = await this.generateTokens(user);
    await this.storeRefreshToken(user.id, tokens.refreshToken);

    return { user: this.sanitizeUser(user), ...tokens };
  }

  // ─── Logout ──────────────────────────────────────────────
  async logout(userId: string) {
    await this.redis.del(`refresh:${userId}`);
    return { message: 'Logged out successfully' };
  }

  // ─── Helpers ─────────────────────────────────────────────
  private async generateTokens(user: UserEntity) {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
    };

    const accessExpiresIn = this.configService.getOrThrow<string>(
      'JWT_ACCESS_EXPIRES',
    ) as StringValue;
    const refreshExpiresIn = this.configService.getOrThrow<string>(
      'JWT_REFRESH_EXPIRES',
    ) as StringValue;

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload, {
        ...ACCESS_TOKEN_SIGN_OPTIONS,
        secret: this.configService.getOrThrow<string>('JWT_ACCESS_SECRET'),
        expiresIn: accessExpiresIn,
      }),
      this.jwtService.signAsync(payload, {
        ...REFRESH_TOKEN_SIGN_OPTIONS,
        secret: this.configService.getOrThrow<string>('JWT_REFRESH_SECRET'),
        expiresIn: refreshExpiresIn,
      }),
    ]);

    return { accessToken, refreshToken };
  }

  private async storeRefreshToken(userId: string, token: string) {
    const ttl = 7 * 24 * 60 * 60; // 7 days in seconds
    await this.redis.set(`refresh:${userId}`, token, 'EX', ttl);
  }

  private sanitizeUser(user: UserEntity) {
    // Never send passwordHash to the client
    const { passwordHash, ...safe } = user;
    return safe;
  }
}