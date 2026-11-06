// Gate 5 (economic-calendar warning) against the real schema: the window's ends are inclusive in Postgres,
// and the UTC event times stored by the calendar sync are compared as instants, so DST never shifts the
// window. The events are real, as the domain-service parsers produce them from the recorded official pages:
// the FOMC meeting of 17-18 Mar 2026 (expected 14:00 New York = 18:00 UTC: New York on EDT since 8 Mar,
// Europe not until 29 Mar) and the ECB decision of 29 Oct 2026 (14:15 Frankfurt = 13:15 UTC: Frankfurt back
// on CET since 25 Oct, New York not until 1 Nov).
//
// Runs in <DB_NAME>_test (created, migrated and dropped per run). Skipped unless RUN_DB_TESTS=true:
//   RUN_DB_TESTS=true npx nx test order-service --testFile=calendar-gate.db.spec.ts --skip-nx-cache
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

  it('stores the two events (the comparisons below are not against an empty table)', async () => {
    expect(testDb.dataSource.options.database).toMatch(/_test$/);
    const rows = await testDb.dataSource.query(`SELECT count(*)::int AS n FROM economic_events`);
    expect(rows[0].n).toBe(2);
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
});
