import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export interface BasicAuthCredentials {
  user: string;
  pass: string;
}

// Bull Board shows every user's backtest jobs (ids, parameters, results) and
// can retry/delete them, so it is an operator-only tool. Browsers don't send
// the app's bearer token to it, hence HTTP Basic auth.
export function bullBoardCredentials(env: NodeJS.ProcessEnv): BasicAuthCredentials | null {
  const user = env['BULL_BOARD_USER'];
  const pass = env['BULL_BOARD_PASS'];
  return user && pass ? { user, pass } : null;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function basicAuth({ user, pass }: BasicAuthCredentials) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization ?? '';
    const [scheme, encoded] = header.split(' ');
    if (scheme === 'Basic' && encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      const sep = decoded.indexOf(':');
      if (sep > 0 && safeEqual(decoded.slice(0, sep), user) && safeEqual(decoded.slice(sep + 1), pass)) {
        next();
        return;
      }
    }
    res.setHeader('WWW-Authenticate', 'Basic realm="bull-board", charset="UTF-8"');
    res.status(401).send('Authentication required');
  };
}
