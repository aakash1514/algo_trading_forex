import { Injectable } from '@nestjs/common';
import { assertUserId } from '@forexedge/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';

export interface JwtPayload {
  sub: string;
  email: string;
  role: string;
  iat?: number;
  exp?: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
    });
  }

  // No DB lookup — trust the token signature
  // req.user will be the decoded payload
  validate(payload: JwtPayload) {
    // A token without a subject would make every user-scoped query unfiltered.
    assertUserId(payload.sub);
    return {
      id: payload.sub,       // matches req.user.id used in controllers
      email: payload.email,
      role: payload.role,
    };
  }
}