import { Injectable } from '@nestjs/common';
import type { Namespace } from 'socket.io';

// Market times in a replay payload: none may be after the session's clock. Wall-clock
// audit times (createdAt, updatedAt, endedAt, cancelledAt) and the user's chosen
// startTime are not market data and are not checked.
const MARKET_TIME_KEYS = new Set(['time', 'lastMinute', 'clockTime', 'entryTime', 'exitTime', 'placedAt', 'exitRequestedAt']);

export class FutureDataError extends Error {}

// Throws if any market time in `payload` is later than `clock` (defence in depth: the
// queries already read nothing after the clock)
export function assertNothingAfterClock(payload: unknown, clock: Date): void {
  const limit = clock.getTime();
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`));
    } else if (value && typeof value === 'object' && !(value instanceof Date)) {
      for (const [key, v] of Object.entries(value)) {
        if (MARKET_TIME_KEYS.has(key) && v !== null && v !== undefined) {
          const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
          if (Number.isNaN(t)) throw new FutureDataError(`${path}.${key} is not a time: ${String(v)}`);
          if (t > limit) {
            throw new FutureDataError(`${path}.${key} ${new Date(t).toISOString()} is after the clock ${clock.toISOString()}`);
          }
        } else {
          walk(v, `${path}.${key}`);
        }
      }
    }
  };
  walk(payload, '$');
}

// Sends replay events to the sockets of one user (room user:<id> in the /replay
// namespace); every payload is checked against the session's clock first.
@Injectable()
export class ReplayEmitter {
  private namespace: Namespace | null = null;

  attach(namespace: Namespace): void {
    this.namespace = namespace;
  }

  toUser(userId: string, event: string, payload: unknown, clock: Date): void {
    assertNothingAfterClock(payload, clock);
    this.namespace?.to(`user:${userId}`).emit(event, payload);
  }

  async socketCount(userId: string): Promise<number> {
    if (!this.namespace) return 0;
    return (await this.namespace.in(`user:${userId}`).fetchSockets()).length;
  }
}
