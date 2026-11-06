// Gate 5 (economic-calendar warning) against the real schema: the window's ends are inclusive in Postgres,
// and the UTC event times stored by the calendar sync are compared as instants, so DST never shifts the
// window. The events are real, as the domain-service parsers produce them from the recorded official pages:
// the FOMC meeting of 17-18 Mar 2026 (expected 14:00 New York = 18:00 UTC: New York on EDT since 8 Mar,
// Europe not until 29 Mar) and the ECB decision of 29 Oct 2026 (14:15 Frankfurt = 13:15 UTC: Frankfurt back
// on CET since 25 Oct, New York not until 1 Nov).
//
// Currency matching uses every timed event of the real Forex Factory export recorded on 2026-11-06 (domain-service
// economic-calendar/forexfactory/__fixtures__/), stored as the calendar sync stores them (UTC from the export's
// offset, impact High/Medium/Low as HIGH/MEDIUM/LOW, holidays skipped).
//
// Runs in <DB_NAME>_test (created, migrated and dropped per run). Skipped unless RUN_DB_TESTS=true:
//   RUN_DB_TESTS=true npx nx test order-service --testFile=calendar-gate.db.spec.ts --skip-nx-cache
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EconomicEventEntity, InstrumentEntity, OrderEntity, PositionEntity } from '@forexedge/database';
import { createTestDatabase, type TestDatabase } from '@forexedge/database/testing';
import { OrderValidationService } from './order-validation.service';
import type { MarketHoursPolicy } from '../market/market-hours.policy';

const run = process.env['RUN_DB_TESTS'] === 'true' ? describe : describe.skip;

const FOMC = { title: 'FOMC meeting, March 17-18, with Summary of Economic Projections', at: '2026-03-18T18:00:00.000Z' };
const ECB = {
  title: 'Governing Council of the ECB: monetary policy meeting in Frankfurt (Day 2), followed by press conference',
  at: '2026-10-29T13:15:00.000Z',
};

const FF_EXPORT = join(__dirname, '../../../domain-service/src/economic-calendar/forexfactory/__fixtures__/ff_calendar_thisweek-2026-11-06.json');
const FF_IMPACT: Record<string, string> = { High: 'HIGH', Medium: 'MEDIUM', Low: 'LOW' };
const FF_EVENTS = (JSON.parse(readFileSync(FF_EXPORT, 'utf8')) as { title: string; country: string; date: string; impact: string }[])
  .filter((e) => FF_IMPACT[e.impact])
  .map((e) => ({ title: e.title, currency: e.country, impact: FF_IMPACT[e.impact], at: new Date(Date.parse(e.date)).toISOString() }));
const PAIRS = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'XAU/USD'];

// The order time at an offset from an event, e.g. '-30:01' = 30 min 1 s before it
function shift(iso: string, offset: string): Date {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  if (!m) throw new Error(`bad offset ${offset}`);
  const seconds = Number(m[2]) * 60 + Number(m[3]);
  return new Date(Date.parse(iso) + (m[1] === '-' ? -1 : 1) * seconds * 1000);
}

run('gate 5 calendar window (real DB)', () => {
  jest.setTimeout(120_000);
  let testDb: TestDatabase;
  let service: OrderValidationService;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    const ds = testDb.dataSource;
    await ds.query(
      `INSERT INTO economic_events (title, currency, impact, scheduled_at, time_source, source) VALUES
       ($1, 'USD', 'HIGH', $2, 'expected', 'FOMC'), ($3, 'EUR', 'HIGH', $4, 'official', 'ECB')`,
      [FOMC.title, FOMC.at, ECB.title, ECB.at],
    );
    for (const e of FF_EVENTS) {
      await ds.query(
        `INSERT INTO economic_events (title, currency, impact, scheduled_at, time_source, source)
         VALUES ($1, $2, $3, $4, 'third_party', 'FOREXFACTORY')`,
        [e.title, e.currency, e.impact, e.at],
      );
    }
    service = new OrderValidationService(
      ds.getRepository(InstrumentEntity), ds.getRepository(EconomicEventEntity), ds.getRepository(OrderEntity),
      ds.getRepository(PositionEntity), {} as MarketHoursPolicy,
    );
  });
  afterAll(async () => {
    await testDb?.drop();
  });

  const near = async (pair: string, orderAt: Date) =>
    (await service.findEventsNearOrder(pair, orderAt)).map((e) => e.title);

  it('stores the events (the comparisons below are not against an empty table)', async () => {
    expect(testDb.dataSource.options.database).toMatch(/_test$/);
    expect(FF_EVENTS).toHaveLength(112);
    const rows = await testDb.dataSource.query(
      `SELECT source, count(*)::int AS n FROM economic_events GROUP BY source ORDER BY source`);
    expect(rows).toEqual([{ source: 'ECB', n: 1 }, { source: 'FOMC', n: 1 }, { source: 'FOREXFACTORY', n: 112 }]);
  });

  it('warns at exactly 30:00 before and after the event, not at 30:01 (expected FOMC time)', async () => {
    expect(await near('EUR/USD', shift(FOMC.at, '-30:00'))).toEqual([FOMC.title]);
    expect(await near('EUR/USD', shift(FOMC.at, '-30:01'))).toEqual([]);
    expect(await near('EUR/USD', shift(FOMC.at, '+30:00'))).toEqual([FOMC.title]);
    expect(await near('EUR/USD', shift(FOMC.at, '+30:01'))).toEqual([]);
  });

  it('warns at exactly 30:00 before and after the event, not at 30:01 (official ECB time)', async () => {
    expect(await near('EUR/USD', shift(ECB.at, '-30:00'))).toEqual([ECB.title]);
    expect(await near('EUR/USD', shift(ECB.at, '-30:01'))).toEqual([]);
    expect(await near('EUR/USD', shift(ECB.at, '+30:00'))).toEqual([ECB.title]);
    expect(await near('EUR/USD', shift(ECB.at, '+30:01'))).toEqual([]);
  });

  it('across a DST change: compares the UTC instant, not the other DST offset', async () => {
    // FOMC on 18 Mar 2026 is 18:00 UTC (EDT); under EST it would be 19:00 UTC
    expect(await near('EUR/USD', new Date('2026-03-18T18:30:00.000Z'))).toEqual([FOMC.title]);
    expect(await near('EUR/USD', new Date('2026-03-18T19:30:00.000Z'))).toEqual([]);
    // ECB on 29 Oct 2026 is 13:15 UTC (CET); under CEST it would be 12:15 UTC
    expect(await near('EUR/USD', new Date('2026-10-29T12:44:59.000Z'))).toEqual([]);
    expect(await near('EUR/USD', new Date('2026-10-29T12:45:00.000Z'))).toEqual([ECB.title]);
  });

  it('matches either currency of the pair only', async () => {
    expect(await near('USD/JPY', new Date(FOMC.at))).toEqual([FOMC.title]);
    expect(await near('USD/JPY', new Date(ECB.at))).toEqual([]);
    expect(await near('XAU/USD', new Date(FOMC.at))).toEqual([FOMC.title]);
  });

  describe('matches the event currency to the order pair (real Forex Factory events)', () => {
    const event = (currency: string, title: string) => {
      const e = FF_EVENTS.find((x) => x.currency === currency && x.title === title);
      if (!e) throw new Error(`${currency} ${title} is not in the recorded export`);
      return e;
    };
    // Every event returned for a pair is in the pair's base or quote currency
    const currenciesNear = async (pair: string, at: string) =>
      (await service.findEventsNearOrder(pair, new Date(at))).map((e) => e.currency);

    it('a USD event (Unemployment Rate, HIGH) warns for EUR/USD, GBP/USD, USD/JPY and XAU/USD', async () => {
      const usd = event('USD', 'Unemployment Rate');
      expect([usd.impact, usd.at]).toEqual(['HIGH', '2026-11-06T13:30:00.000Z']);
      for (const pair of PAIRS) {
        const found = await service.findEventsNearOrder(pair, new Date(usd.at));
        expect(found.some((e) => e.currency === 'USD' && e.title === 'Unemployment Rate')).toBe(true);
      }
      // the CAD release at the same moment warns for none of them
      expect(FF_EVENTS.some((e) => e.currency === 'CAD' && e.title === 'Unemployment Rate' && e.at === usd.at)).toBe(true);
      for (const pair of PAIRS) expect(await currenciesNear(pair, usd.at)).not.toContain('CAD');
      expect(await currenciesNear('EUR/USD', usd.at)).toEqual(expect.arrayContaining(['USD']));
      expect(new Set(await currenciesNear('XAU/USD', usd.at))).toEqual(new Set(['USD']));
    });

    it('a JPY event (BOJ Gov Ueda Speaks, HIGH) warns for USD/JPY only', async () => {
      const jpy = event('JPY', 'BOJ Gov Ueda Speaks');
      expect([jpy.impact, jpy.at]).toEqual(['HIGH', '2026-11-06T16:00:00.000Z']);
      expect(await currenciesNear('USD/JPY', jpy.at)).toContain('JPY');
      for (const pair of ['EUR/USD', 'GBP/USD', 'XAU/USD']) expect(await currenciesNear(pair, jpy.at)).not.toContain('JPY');
    });

    it('an AUD event (RBA Rate Statement, HIGH) and the CNY events warn for none of the 4 pairs', async () => {
      const aud = event('AUD', 'RBA Rate Statement');
      expect([aud.impact, aud.at]).toEqual(['HIGH', '2026-11-03T03:30:00.000Z']);
      for (const pair of PAIRS) expect(await currenciesNear(pair, aud.at)).toEqual([]);
      // CNY has Low entries only this week (also outside the gate's HIGH/MEDIUM filter)
      const cny = FF_EVENTS.filter((e) => e.currency === 'CNY');
      expect(cny.length).toBeGreaterThan(0);
      for (const e of cny) for (const pair of PAIRS) expect(await currenciesNear(pair, e.at)).not.toContain('CNY');
    });

    it('every event found for any pair, at any recorded event time, is in that pair', async () => {
      let checked = 0;
      for (const e of FF_EVENTS) {
        for (const pair of PAIRS) {
          const [base, quote] = pair.split('/');
          for (const c of await currenciesNear(pair, e.at)) {
            expect([base, quote]).toContain(c);
            checked++;
          }
        }
      }
      expect(checked).toBeGreaterThan(0);
    });
  });
});
