import { cookieSecure, corsOrigins, DEV_CORS_ORIGINS, parseFlag, registrationEnabled, requiredInProduction } from './runtime-env';

const prod = { NODE_ENV: 'production' };

describe('runtime env', () => {
  describe('CORS_ORIGIN', () => {
    it('production without CORS_ORIGIN fails startup', () => {
      expect(() => corsOrigins(prod)).toThrow('CORS_ORIGIN must be set when NODE_ENV=production');
      expect(() => corsOrigins({ ...prod, CORS_ORIGIN: '  ' })).toThrow('CORS_ORIGIN must be set');
    });

    it('production allows exactly the configured origins (no localhost:3001)', () => {
      expect(corsOrigins({ ...prod, CORS_ORIGIN: 'https://app.example.test' })).toEqual(['https://app.example.test']);
      expect(corsOrigins({ ...prod, CORS_ORIGIN: 'https://a.example.test, https://b.example.test' }))
        .toEqual(['https://a.example.test', 'https://b.example.test']);
    });

    it('development without it allows the local frontend and Grafana', () => {
      expect(corsOrigins({})).toEqual(DEV_CORS_ORIGINS);
    });

    it.each(['https://app.example.test/', 'https://app.example.test/path', 'app.example.test', 'not a url'])(
      'refuses %p (not an origin)', (origin) => {
        expect(() => corsOrigins({ CORS_ORIGIN: origin })).toThrow();
      });
  });

  describe('COOKIE_SECURE', () => {
    it('defaults to true in production and false in development', () => {
      expect(cookieSecure(prod)).toBe(true);
      expect(cookieSecure({})).toBe(false);
    });
    it('an explicit value wins (e.g. a local prod-like run over http)', () => {
      expect(cookieSecure({ ...prod, COOKIE_SECURE: 'false' })).toBe(false);
      expect(cookieSecure({ COOKIE_SECURE: 'true' })).toBe(true);
    });
  });

  describe('REGISTRATION_ENABLED', () => {
    it('unset means closed, in development and production', () => {
      expect(registrationEnabled({})).toBe(false);
      expect(registrationEnabled(prod)).toBe(false);
      expect(registrationEnabled({ REGISTRATION_ENABLED: 'true' })).toBe(true);
    });
  });

  it.each(['TRUE', 'yes', '1', ' true'])('a flag of %p fails instead of being guessed', (raw) => {
    expect(() => parseFlag('X', raw, false)).toThrow('X must be "true" or "false"');
  });

  it('requiredInProduction: missing in production throws, missing in development is undefined', () => {
    expect(() => requiredInProduction('STORAGE', prod)).toThrow('STORAGE must be set when NODE_ENV=production');
    expect(requiredInProduction('STORAGE', {})).toBeUndefined();
    expect(requiredInProduction('STORAGE', { ...prod, STORAGE: 's3' })).toBe('s3');
  });
});
