import { CanActivate, ForbiddenException, Injectable } from '@nestjs/common';
import { registrationEnabled } from '@forexedge/common';

export const REGISTRATION_CLOSED_MESSAGE = 'Registration is closed';

// POST /api/auth/register only while REGISTRATION_ENABLED=true (unset = closed). A guard runs before
// the ValidationPipe, so a closed registration is a 403 for any body, never a validation error that
// would describe the form. The flag is read once, at startup: an invalid value fails startup.
@Injectable()
export class RegistrationOpenGuard implements CanActivate {
  readonly open = registrationEnabled();

  canActivate(): boolean {
    if (!this.open) throw new ForbiddenException(REGISTRATION_CLOSED_MESSAGE);
    return true;
  }
}
