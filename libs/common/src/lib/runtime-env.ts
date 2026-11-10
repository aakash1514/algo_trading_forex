// Settings that differ between a laptop and production, read once at startup. Every value comes from
// the environment; nothing here knows the production domain.
//
//   NODE_ENV=production   set by the production containers (never in the dev .env, see CLAUDE.md).
//                         Settings that would be unsafe to guess are then required: a missing one fails
//                         startup instead of falling back to a development default.
//   CORS_ORIGIN           comma-separated origins allowed to call the APIs with credentials
//                         (production: https://<domain>). Unset in development: the local frontend
//                         (4200) and Grafana (3001). Required in production.
//   COOKIE_SECURE         true/false: the refresh cookie is sent over HTTPS only. Defaults to true in
//                         production, false in development (http://localhost).
//   REGISTRATION_ENABLED  true/false: whether POST /api/auth/register creates accounts. Unset means
//                         false (closed), in every environment; the dev .env sets true.

export type Env = Readonly<Record<string, string | undefined>>;

export const DEV_CORS_ORIGINS: readonly string[] = ['http://localhost:4200', 'http://localhost:3001'];

export function isProduction(env: Env = process.env): boolean {
  return env['NODE_ENV'] === 'production';
}

// A strict true/false flag: anything else (yes, 1, TRUE ) fails startup rather than being guessed
export function parseFlag(name: string, raw: string | undefined, whenUnset: boolean): boolean {
  if (raw === undefined || raw === '') return whenUnset;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be "true" or "false", got "${raw}"`);
}

// The value of a setting that production must state explicitly, or the development default
export function requiredInProduction(name: string, env: Env = process.env): string | undefined {
  const value = env[name]?.trim();
  if (!value && isProduction(env)) throw new Error(`${name} must be set when NODE_ENV=production`);
  return value || undefined;
}

export function corsOrigins(env: Env = process.env): string[] {
  const raw = requiredInProduction('CORS_ORIGIN', env);
  if (!raw) return [...DEV_CORS_ORIGINS];
  const origins = raw.split(',').map((o) => o.trim()).filter(Boolean);
  for (const origin of origins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error(`CORS_ORIGIN has an invalid origin "${origin}"`);
    }
    // An origin is scheme://host[:port] only; a path or trailing slash never matches a browser's Origin
    if (url.origin !== origin) throw new Error(`CORS_ORIGIN entry "${origin}" must be an origin like ${url.origin}`);
  }
  if (origins.length === 0) throw new Error('CORS_ORIGIN is empty');
  return origins;
}

export function cookieSecure(env: Env = process.env): boolean {
  return parseFlag('COOKIE_SECURE', env['COOKIE_SECURE'], isProduction(env));
}

export function registrationEnabled(env: Env = process.env): boolean {
  return parseFlag('REGISTRATION_ENABLED', env['REGISTRATION_ENABLED'], false);
}
