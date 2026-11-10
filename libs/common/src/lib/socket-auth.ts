import { ACCESS_TOKEN_VERIFY_OPTIONS } from './jwt-claims';

// Access tokens on long-lived sockets (ws-gateway, replay-service /replay).
//
// A token is checked at the handshake with the same algorithm, issuer and audience as the REST guards,
// and the socket is then held to the token's expiry: when it passes, the server emits AUTH_EXPIRED_EVENT
// and disconnects. replay-service also accepts REAUTH_EVENT with a fresh access token of the same user,
// which moves the deadline; a refused reauth leaves the old deadline in place.

export const AUTH_EXPIRED_EVENT = 'authExpired';
export const REAUTH_EVENT = 'reauth';

export interface VerifiedAccessToken {
  userId: string;
  expiresAtMs: number;
}

// JwtService.verify's shape, so this lib needs no @nestjs/jwt import
export interface TokenVerifier {
  verify<T extends object>(token: string, options: object): T;
}

// The user and expiry of a valid access token, or null. A token without exp is refused: it would
// keep a socket open forever (jsonwebtoken itself accepts one).
export function verifyAccessToken(verifier: TokenVerifier, token: unknown, secret: string): VerifiedAccessToken | null {
  if (typeof token !== 'string' || token === '') return null;
  try {
    const payload = verifier.verify<{ sub?: unknown; exp?: unknown }>(token, {
      ...ACCESS_TOKEN_VERIFY_OPTIONS,
      algorithms: [...ACCESS_TOKEN_VERIFY_OPTIONS.algorithms],
      secret,
    });
    if (typeof payload.sub !== 'string' || payload.sub.trim() === '') return null; // room user:undefined
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return null;
    return { userId: payload.sub, expiresAtMs: payload.exp * 1000 };
  } catch {
    return null;
  }
}

// setTimeout's limit (~24.8 days); a later deadline is reached in steps
const MAX_TIMER_MS = 2 ** 31 - 1;

// One deadline per socket. schedule() replaces the previous deadline; clear() on disconnect.
export class SocketDeadlines {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly now: () => number = Date.now) {}

  schedule(socketId: string, atMs: number, onExpire: () => void): void {
    this.clear(socketId);
    const arm = () => {
      const delay = atMs - this.now();
      if (delay <= 0) {
        this.timers.delete(socketId);
        onExpire();
        return;
      }
      this.timers.set(socketId, setTimeout(arm, Math.min(delay, MAX_TIMER_MS)));
    };
    arm();
  }

  clear(socketId: string): void {
    const timer = this.timers.get(socketId);
    if (timer) clearTimeout(timer);
    this.timers.delete(socketId);
  }

  get size(): number {
    return this.timers.size;
  }
}
