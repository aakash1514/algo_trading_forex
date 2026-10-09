import { UnauthorizedException } from '@nestjs/common';

// TypeORM drops `undefined` values from a `where` object, so a query scoped by a
// missing user id silently matches every row (e.g. every user's positions).
// Call this before any user-scoped query, so a missing id fails closed.
export function assertUserId(userId: unknown): asserts userId is string {
  if (typeof userId !== 'string' || userId.trim() === '') {
    throw new UnauthorizedException('Missing authenticated user id');
  }
}
