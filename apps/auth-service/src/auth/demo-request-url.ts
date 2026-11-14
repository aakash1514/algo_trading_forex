import { Logger } from '@nestjs/common';
import type { Env } from '@forexedge/common';

// DEMO_REQUEST_URL: where a visitor asks for a demo login while sign-up is closed (the login page links
// to it, GET /api/auth/config returns it as demoRequestUrl). Optional. The page puts it in an <a href>,
// so only an absolute https:// URL is accepted: javascript:, data:, http:, a relative or malformed value
// would turn the link into a script, a downgrade or a dead end. A rejected value is not a reason to stop
// the login page from working, so it is dropped with a startup warning (null), never a startup failure.

export const DEMO_REQUEST_URL_MAX_LENGTH = 2048;

export type DemoRequestUrl = { url: string | null; rejected: string | null };

export function parseDemoRequestUrl(raw: string | undefined): DemoRequestUrl {
  const value = raw?.trim() ?? '';
  if (value === '') return { url: null, rejected: null };
  const reject = (why: string): DemoRequestUrl => ({ url: null, rejected: why });

  if (value.length > DEMO_REQUEST_URL_MAX_LENGTH) return reject(`longer than ${DEMO_REQUEST_URL_MAX_LENGTH} characters`);
  // The URL parser silently drops tabs and newlines and accepts "https:host"; neither is a clean absolute URL
  if (/\s/.test(value) || [...value].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)) {
    return reject('contains whitespace or control characters');
  }
  if (!/^https:\/\//i.test(value)) return reject('must be an absolute https:// URL');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return reject('is not a valid URL');
  }
  if (url.protocol !== 'https:' || url.hostname === '') return reject('must be an absolute https:// URL');
  if (url.username !== '' || url.password !== '') return reject('must not carry a user name or password');
  return { url: url.href, rejected: null };
}

// Read once, at startup (the controller's construction); logs why a value was dropped, without echoing it
export function demoRequestUrl(env: Env = process.env, logger = new Logger('DemoRequestUrl')): string | null {
  const { url, rejected } = parseDemoRequestUrl(env['DEMO_REQUEST_URL']);
  if (rejected) logger.warn(`DEMO_REQUEST_URL ignored: ${rejected}. The login page shows no demo-request link.`);
  return url;
}
