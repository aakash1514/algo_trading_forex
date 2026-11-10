/** @jest-environment node */
import { GET as live } from './live/route';
import { GET as ready } from './ready/route';

describe('frontend health routes', () => {
  it.each([['live', live, { status: 'ok' }], ['ready', ready, { status: 'ok', checks: {} }]])(
    '/health/%s answers 200 with the status only, never cached',
    async (_name, get, body) => {
      const res = get();
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toEqual(body);
    },
  );
});
