import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser = require('cookie-parser');
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { RegistrationOpenGuard } from './guards/registration-open.guard';

// Registration switch and the refresh cookie over real HTTP, with main.ts's ValidationPipe options.
// The guard and cookie settings are read when the module is built, so each case sets the env first.

const VALID = { email: 'new.trader@example.com', username: 'new_trader', password: 'Str0ng!Passw0rd', firstName: 'New', lastName: 'Trader' };
const tokens = { user: { id: 'u1' }, accessToken: 'access', refreshToken: 'refresh' };

async function start(env: Record<string, string | undefined>) {
  const saved = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const auth = { register: jest.fn().mockResolvedValue(tokens), login: jest.fn().mockResolvedValue(tokens) };
  try {
    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: auth }, RegistrationOpenGuard],
    }).compile();
    const app: INestApplication = moduleRef.createNestApplication({ logger: false });
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    return { app, url: await app.getUrl(), auth };
  } finally {
    process.env = saved;
  }
}

const post = (url: string, path: string, body: unknown) =>
  fetch(`${url}/api/auth/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('AuthController: registration switch and refresh cookie', () => {
  let app: INestApplication | undefined;
  afterEach(async () => { await app?.close(); app = undefined; });

  it('REGISTRATION_ENABLED unset: sign-up is 403 for a valid or an invalid body, and config says closed', async () => {
    const s = await start({ REGISTRATION_ENABLED: undefined });
    app = s.app;
    for (const body of [VALID, { email: 'not-an-email' }]) {
      const res = await post(s.url, 'register', body);
      expect(res.status).toBe(403);
      expect((await res.json()).message).toBe('Registration is closed');
    }
    expect(s.auth.register).not.toHaveBeenCalled();
    expect(await (await fetch(`${s.url}/api/auth/config`)).json()).toEqual({ registrationEnabled: false });
  });

  it('REGISTRATION_ENABLED=true: sign-up works and validation still applies', async () => {
    const s = await start({ REGISTRATION_ENABLED: 'true' });
    app = s.app;
    expect((await post(s.url, 'register', VALID)).status).toBe(201);
    expect((await post(s.url, 'register', { ...VALID, password: 'short' })).status).toBe(400);
    expect(s.auth.register).toHaveBeenCalledTimes(1);
    expect(await (await fetch(`${s.url}/api/auth/config`)).json()).toEqual({ registrationEnabled: true });
  });

  it('an invalid REGISTRATION_ENABLED fails at startup', async () => {
    await expect(start({ REGISTRATION_ENABLED: 'yes' })).rejects.toThrow('REGISTRATION_ENABLED must be "true" or "false"');
  });

  it('development: the refresh cookie is HttpOnly, SameSite=Lax, path /api/auth, not Secure', async () => {
    const s = await start({ NODE_ENV: undefined, COOKIE_SECURE: undefined });
    app = s.app;
    const cookie = (await post(s.url, 'login', { email: 'a@example.com', password: 'whatever' })).headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^refresh_token=refresh;/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\/api\/auth/);
    expect(cookie).not.toMatch(/Secure/);
  });

  it('NODE_ENV=production: the refresh cookie is Secure by default', async () => {
    const s = await start({ NODE_ENV: 'production', COOKIE_SECURE: undefined });
    app = s.app;
    const cookie = (await post(s.url, 'login', { email: 'a@example.com', password: 'whatever' })).headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/; Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
  });
});
