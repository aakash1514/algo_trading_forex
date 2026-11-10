import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { UsersService } from '../../users/users.service';
import { ACCESS_TOKEN_VERIFY_OPTIONS, assertUserId } from '@forexedge/common';

export interface JwtPayload {
  sub: string;      // user id
  email: string;
  role: string;
  iat?: number;     // issued at
  exp?: number;     // expires at
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    private readonly configService: ConfigService,
    private readonly usersService: UsersService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      algorithms: [...ACCESS_TOKEN_VERIFY_OPTIONS.algorithms],
      issuer: ACCESS_TOKEN_VERIFY_OPTIONS.issuer,
      audience: ACCESS_TOKEN_VERIFY_OPTIONS.audience,
      secretOrKey: configService.getOrThrow<string>('JWT_ACCESS_SECRET'),
    });
  }

  async validate(payload: JwtPayload) {
    assertUserId(payload.sub);
    const user = await this.usersService.findById(payload.sub);
    if (!user) {
      throw new UnauthorizedException('User no longer exists');
    }
    return user; // attached to request.user
  }
}