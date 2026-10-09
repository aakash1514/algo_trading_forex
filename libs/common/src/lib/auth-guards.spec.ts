import { UnauthorizedException } from '@nestjs/common';
import { assertUserId } from './auth-guards';

describe('assertUserId', () => {
  it('accepts a non-empty string', () => {
    expect(() => assertUserId('8023fc9e-a880-4680-997d-65dd53fcfd77')).not.toThrow();
  });

  it.each([undefined, null, '', '   ', 42, {}])('rejects %p with 401 instead of matching everything', (value) => {
    expect(() => assertUserId(value)).toThrow(UnauthorizedException);
  });
});
