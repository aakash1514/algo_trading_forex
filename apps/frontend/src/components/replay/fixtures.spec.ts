/** @jest-environment node */
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import manifest from './__fixtures__/manifest.json';
import { centsToDecimal, decimalToCents } from '../../lib/replay';
import { openPnlCents } from '../../lib/replay-money';
import type { ReplayState } from '../../types/replay.types';

const DIR = join(__dirname, '__fixtures__');
const entries = Object.values(manifest.fixtures as Record<string, { file: string; sha256: string; kind: string; status?: number }>);
const state = (name: string) => JSON.parse(readFileSync(join(DIR, `${name}.json`), 'utf8')) as ReplayState;

// The recorded replay-service responses are the committed bytes the recorder saved (README.md)
describe('replay page fixtures', () => {
  it('match the sha256 the recorder wrote', () => {
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(createHash('sha256').update(readFileSync(join(DIR, e.file))).digest('hex')).toBe(e.sha256);
    }
  });

  it('cover the REST cases and socket events the page handles', () => {
    expect(entries.filter((e) => e.kind === 'rest').map((e) => e.status).sort()).toEqual([200, 200, 200, 201, 201, 400, 400, 409]);
    expect(Object.keys(manifest.fixtures)).toEqual(expect.arrayContaining([
      'state-no-session', 'state-paused', 'bar-1m', 'positions-pending', 'account-after-order', 'positions-filled',
      'status-paused-user', 'end-of-data', 'state-end-of-data', 'ended',
    ]));
  });
});

// Each open position's P&L is computed in the page with trading-sim's markToMarketCents
// at the current bar's close; the server sends only the total. They must agree exactly.
describe('per-position P&L', () => {
  it.each(['state-open-positions', 'state-closed-trades', 'state-usdjpy-open-positions'])(
    'the rows of %s add up to the server’s unrealizedPnlUsd', (name) => {
      const s = state(name);
      const open = s.positions.filter((p) => p.status === 'OPEN');
      expect(open.length).toBeGreaterThan(0);
      const sum = open.reduce((acc, p) => acc + (openPnlCents(p, s.currentBar, s.session.instrument, s.priceDecimals) as bigint), 0n);
      expect(centsToDecimal(sum)).toBe(s.account.unrealizedPnlUsd);
      expect(decimalToCents(s.account.equity) - decimalToCents(s.account.balance)).toBe(sum);
    });

  it('is null for a position that is not open', () => {
    const s = state('state-closed-trades');
    const notOpen = s.positions.filter((p) => p.status !== 'OPEN');
    expect(notOpen.length).toBeGreaterThan(0);
    for (const p of notOpen) expect(openPnlCents(p, s.currentBar, s.session.instrument, s.priceDecimals)).toBeNull();
  });
});
