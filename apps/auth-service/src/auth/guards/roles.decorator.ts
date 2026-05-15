import { SetMetadata } from '@nestjs/common';
import { UserRole } from '@forexedge/database';

export const Roles = (...roles: UserRole[]) =>
  SetMetadata('roles', roles);