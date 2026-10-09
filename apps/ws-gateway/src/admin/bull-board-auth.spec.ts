import type { Request, Response } from 'express';
import { basicAuth, bullBoardCredentials } from './bull-board-auth';

const run = (authorization?: string) => {
  const req = { headers: authorization ? { authorization } : {} } as Request;
  const res = { setHeader: jest.fn(), status: jest.fn().mockReturnThis(), send: jest.fn() };
  const next = jest.fn();
  basicAuth({ user: 'ops', pass: 's3cret' })(req, res as unknown as Response, next);
  return { res, next };
};
const basic = (creds: string) => `Basic ${Buffer.from(creds).toString('base64')}`;

describe('Bull Board basic auth', () => {
  it('lets the configured operator through', () => {
    expect(run(basic('ops:s3cret')).next).toHaveBeenCalled();
  });

  it.each([
    ['no header', undefined],
    ['wrong password', basic('ops:nope')],
    ['wrong user', basic('admin:s3cret')],
    ['a bearer token', 'Bearer eyJhbGciOi...'],
    ['malformed', 'Basic !!!'],
  ])('rejects %s with 401', (_label, header) => {
    const { res, next } = run(header);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.setHeader).toHaveBeenCalledWith('WWW-Authenticate', expect.stringContaining('Basic'));
  });

  it('is disabled (null) unless both credentials are configured', () => {
    expect(bullBoardCredentials({})).toBeNull();
    expect(bullBoardCredentials({ BULL_BOARD_USER: 'ops' })).toBeNull();
    expect(bullBoardCredentials({ BULL_BOARD_USER: 'ops', BULL_BOARD_PASS: 'x' })).toEqual({ user: 'ops', pass: 'x' });
  });
});
