import { UnauthorizedException } from '@nestjs/common';
import { JwtStrategy } from './jwt.strategy';

describe('ws-gateway JwtStrategy.validate', () => {
  const validate = (payload: object) => JwtStrategy.prototype.validate.call({}, payload as never);

  it('maps sub to req.user.id', () => {
    expect(validate({ sub: 'user-1', email: 'a@b.c', role: 'TRADER' })).toEqual({ id: 'user-1', email: 'a@b.c', role: 'TRADER' });
  });

  it('rejects a token without a subject (would unscope every query)', () => {
    expect(() => validate({ email: 'a@b.c', role: 'TRADER' })).toThrow(UnauthorizedException);
  });
});
