import { Injectable } from '@nestjs/common';
import { ACCESS_TOKEN_VERIFY_OPTIONS, assertUserId } from '@forexedge/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

interface JwtPayload {
  sub: string;
  email: string;
  role: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    const secret = process.env.JWT_ACCESS_SECRET;
    if (!secret) {
      throw new Error('JWT_ACCESS_SECRET is not set');
    }
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      algorithms: [...ACCESS_TOKEN_VERIFY_OPTIONS.algorithms],
      issuer: ACCESS_TOKEN_VERIFY_OPTIONS.issuer,
      audience: ACCESS_TOKEN_VERIFY_OPTIONS.audience,
      secretOrKey: secret,
    });
  }

  validate(payload: JwtPayload) {
    // A token without a subject would make every user-scoped query unfiltered.
    assertUserId(payload.sub);
    return { id: payload.sub, email: payload.email, role: payload.role };
  }
}