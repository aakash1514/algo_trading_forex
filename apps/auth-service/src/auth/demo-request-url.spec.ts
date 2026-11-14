import { Logger } from '@nestjs/common';
import { DEMO_REQUEST_URL_MAX_LENGTH, demoRequestUrl, parseDemoRequestUrl } from './demo-request-url';

// DEMO_REQUEST_URL ends up in an <a href> on the login page: only an absolute https:// URL may pass.

describe('parseDemoRequestUrl', () => {
  it('unset or blank: null, nothing to warn about', () => {
    for (const raw of [undefined, '', '   ']) expect(parseDemoRequestUrl(raw)).toEqual({ url: null, rejected: null });
  });

  it('accepts an absolute https:// URL (trimmed, normalized)', () => {
    expect(parseDemoRequestUrl('https://www.linkedin.com/in/someone/')).toEqual({ url: 'https://www.linkedin.com/in/someone/', rejected: null });
    expect(parseDemoRequestUrl('  HTTPS://Example.COM/demo?x=1#y ')).toEqual({ url: 'https://example.com/demo?x=1#y', rejected: null });
  });

  it.each([
    ['javascript:alert(1)', 'must be an absolute https:// URL'],
    ['JavaScript:alert(1)//https://x', 'must be an absolute https:// URL'],
    ['data:text/html,<script>alert(1)</script>', 'must be an absolute https:// URL'],
    ['http://www.linkedin.com/in/someone', 'must be an absolute https:// URL'],
    ['//www.linkedin.com/in/someone', 'must be an absolute https:// URL'],
    ['/register', 'must be an absolute https:// URL'],
    ['www.linkedin.com/in/someone', 'must be an absolute https:// URL'],
    ['https:www.linkedin.com', 'must be an absolute https:// URL'],
    ['https://', 'is not a valid URL'],
    ['https://exa mple.com', 'contains whitespace or control characters'],
    ['https://example.com/\njavascript:alert(1)', 'contains whitespace or control characters'],
    ['https://user:pass@example.com/', 'must not carry a user name or password'],
    [`https://example.com/${'a'.repeat(DEMO_REQUEST_URL_MAX_LENGTH)}`, `longer than ${DEMO_REQUEST_URL_MAX_LENGTH} characters`],
  ])('drops %j (%s)', (raw, why) => {
    expect(parseDemoRequestUrl(raw)).toEqual({ url: null, rejected: why });
  });
});

describe('demoRequestUrl (startup)', () => {
  it('a rejected value is a warning and null; the warning never echoes the value', () => {
    const logger = new Logger('test');
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    expect(demoRequestUrl({ DEMO_REQUEST_URL: 'javascript:alert(1)' }, logger)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/^DEMO_REQUEST_URL ignored: must be an absolute https:\/\/ URL/);
    expect(warn.mock.calls[0][0]).not.toContain('alert');
  });

  it('a valid value or none: no warning', () => {
    const logger = new Logger('test');
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    expect(demoRequestUrl({ DEMO_REQUEST_URL: 'https://example.com/demo' }, logger)).toBe('https://example.com/demo');
    expect(demoRequestUrl({}, logger)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});
