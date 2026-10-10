// Concurrency test against the real database (lost updates only show up with
// real transactions and row locks, not with mocks). The tick consumer's batch
// processing, order fills and position closes run interleaved on one account;
// afterwards the account must agree with its positions:
//   balance     = 10,000 + realized P&L
//   margin_used = margin of the open positions
//   open P&L    = sum of the open positions (derived on read)
//
// Isolation: tick processing works on every open position of a pair, so the test
// trades a pair no real position can have (TST/USD, priced by the test only) and
// refuses to run if anything else is open on it. Nothing outside the test user is
// read or written; the suite asserts that by checksumming every other row.
//
// Skipped unless RUN_DB_TESTS=true. Uses the local DB from the root .env and
// cleans up the user it creates:
//   RUN_DB_TESTS=true npx nx test order-service --testFile=account-consistency.db.spec.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import {
  AccountSummaryEntity, EconomicEventEntity, InstrumentEntity, OrderEntity, PositionEntity, UserEntity,
} from '@forexedge/database';
import { OrderService } from '../order/order.service';
import { PositionService } from '../position/position.service';
import { AccountService, PAPER_STARTING_BALANCE } from './account.service';
import { AccountInvariantMonitor } from './account-invariant.monitor';

jest.mock('kafkajs', () => ({
  Kafka: jest.fn(() => ({ producer: () => ({ connect: jest.fn().mockResolvedValue(undefined), send: jest.fn().mockResolvedValue(undefined) }) })),
}));

const run = process.env['RUN_DB_TESTS'] === 'true' ? describe : describe.skip;

function rootEnv(): Record<string, string> {
  const text = readFileSync(join(__dirname, '../../../../.env'), 'utf8');
  return Object.fromEntries(text.split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
}

const PAIR = 'TST/USD';
const INSTRUMENT = 'TST_USD';

// Checksum of every positions/orders/account row that isn't the test user's
const othersChecksum = (ds: DataSource, userId: string) => ds.query(`
  SELECT md5(coalesce(string_agg(t, '|' ORDER BY t), '')) AS sum FROM (
    SELECT row(p.*)::text AS t FROM positions p WHERE p.user_id <> $1
    UNION ALL SELECT row(o.*)::text FROM orders o WHERE o.user_id <> $1
    UNION ALL SELECT row(a.id, a.user_id, a.balance, a.margin_used, a.leverage)::text FROM account_summary a WHERE a.user_id <> $1
  ) x`, [userId]).then((r: { sum: string }[]) => r[0].sum);

run('account consistency under concurrent ticks, fills and closes (real DB)', () => {
  jest.setTimeout(120_000);
  let dataSource: DataSource;
  let userId: string;
  // The mock price walks; every component reads the same current quote
  let mid = 1.08;
  const quote = () => ({ bid: Number((mid - 0.00005).toFixed(5)), ask: Number((mid + 0.00005).toFixed(5)), mid });

  beforeAll(async () => {
    const env = rootEnv();
    dataSource = new DataSource({
      type: 'postgres', host: env['DB_HOST'] || 'localhost', port: Number(env['DB_PORT']),
      username: env['DB_USER'], password: env['DB_PASS'], database: env['DB_NAME'],
      entities: [UserEntity, OrderEntity, PositionEntity, AccountSummaryEntity, InstrumentEntity, EconomicEventEntity],
      synchronize: false,
    });
    await dataSource.initialize();
    const stamp = Date.now();
    const [{ id }] = await dataSource.query(
      `INSERT INTO users (email, username, password_hash, first_name, last_name)
       VALUES ($1, $2, 'not-a-real-hash', 'Concurrency', 'Test') RETURNING id`,
      [`concurrency${stamp}@example.com`, `concurrency_${stamp}`],
    );
    userId = id;
    await dataSource.query(`INSERT INTO account_summary (user_id, balance, margin_used, leverage) VALUES ($1, $2, 0, 100)`,
      [userId, PAPER_STARTING_BALANCE]);
  });

  afterAll(async () => {
    if (!dataSource?.isInitialized) return;
    await dataSource.query('DELETE FROM positions WHERE user_id = $1', [userId]);
    await dataSource.query('DELETE FROM orders WHERE user_id = $1', [userId]);
    await dataSource.query('DELETE FROM account_summary WHERE user_id = $1', [userId]);
    await dataSource.query('DELETE FROM users WHERE id = $1', [userId]);
    await dataSource.destroy();
  });

  it('keeps balance, margin and open P&L consistent with the positions', async () => {
    const [{ others }] = await dataSource.query(`SELECT count(*)::int AS others FROM positions WHERE pair = $1 AND is_open`, [PAIR]);
    expect(others).toBe(0); // the test pair must be untouched by anything real
    const before = await othersChecksum(dataSource, userId);

    const spec = { lotSize: 100_000, pipSize: 0.0001, maxLeverage: null };
    const pricing = {
      getSpec: async () => spec,
      getInstrumentKind: async () => 'MAJOR',
      quoteToUsd: async () => 1,
      getQuote: async () => quote(),
      getLastQuote: async () => quote(),
      valuePosition: async (_pair: string, lots: number, price: number, leverage: number) => ({
        units: lots * 100_000, marginRequired: Math.round(lots * 100_000 * price / leverage * 100) / 100,
        pipValue: lots * 10, quoteToUsd: 1,
      }),
    };
    const realtime = { positionPnl: () => undefined, positionsChanged: async () => undefined };
    const openPairs = { has: () => true, opened: () => undefined, closed: () => undefined };
    const marketHours = { enforced: false, status: () => ({ open: true }) };
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const positions = new PositionService(
      dataSource.getRepository(PositionEntity), dataSource.getRepository(OrderEntity), dataSource,
      realtime as any, pricing as any, openPairs as any, marketHours as any,
    );
    const orders = new OrderService(
      dataSource.getRepository(OrderEntity), dataSource.getRepository(AccountSummaryEntity), dataSource,
      { fillOrder: async (_o: unknown, q: { ask: number }) => ({ executedPrice: q.ask, executedAt: new Date() }) } as any,
      { validate: async (_u: unknown, _d: unknown, _q: unknown, margin: () => Promise<unknown>) => margin() } as any,
      { valuePosition: pricing.valuePosition, canOpenPosition: async () => ({ valid: true }) } as any,
      realtime as any, pricing as any, openPairs as any, marketHours as any,
    );
    /* eslint-enable @typescript-eslint/no-explicit-any */
    const accounts = new AccountService(dataSource.getRepository(AccountSummaryEntity), dataSource.getRepository(PositionEntity));

    // A position that stays open and is marked on every batch
    await orders.submitOrder(userId, { instrument: INSTRUMENT, direction: 'LONG', orderType: 'MARKET', lots: 1 }, `held-${userId}`);

    const deadline = Date.now() + 8_000;
    const pause = () => new Promise((r) => setTimeout(r, Math.random() * 15));

    const ticker = async () => {
      while (Date.now() < deadline) {
        const batch = Array.from({ length: 5 }, (_, i) => {
          mid = Number((mid + (Math.random() - 0.5) * 0.0004).toFixed(5));
          return { pair: PAIR, ...quote(), timestamp: new Date(Date.now() + i).toISOString() };
        });
        await positions.processTicks(batch);
        await pause();
      }
    };
    let opened = 0;
    let closed = 0;
    const trader = async (lane: number) => {
      let n = 0;
      while (Date.now() < deadline) {
        const order = await orders.submitOrder(userId, { instrument: INSTRUMENT, direction: lane % 2 ? 'SHORT' : 'LONG', orderType: 'MARKET', lots: 0.1 },
          `lane${lane}-${n++}-${userId}`);
        opened++;
        await pause();
        const position = await dataSource.getRepository(PositionEntity).findOne({ where: { orderId: order.id } });
        if (position) {
          await positions.closePosition(position.id, 'MANUAL', quote().bid);
          closed++;
        }
        await pause();
      }
    };

    await Promise.all([ticker(), trader(1), trader(2), trader(3)]);

    expect(opened).toBeGreaterThan(20);
    expect(closed).toBeGreaterThan(20);

    // Stored balance and margin agree with the positions (the minute check finds no drift)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const drifts = await new AccountInvariantMonitor(dataSource as any).check();
    expect(drifts.filter((d) => d.userId === userId)).toEqual([]);

    // Open P&L is the sum of the open positions
    const [{ open_pnl, open_count }] = await dataSource.query(
      'SELECT COALESCE(SUM(unrealized_pnl), 0)::float8 AS open_pnl, count(*)::int AS open_count FROM positions WHERE user_id = $1 AND is_open',
      [userId],
    );
    const summary = await accounts.getAccountSummary(userId);
    expect(open_count).toBe(1);
    expect(summary.unrealizedPnl).toBeCloseTo(open_pnl, 2);
    expect(summary.equity).toBeCloseTo(summary.balance + open_pnl, 2);

    // Nothing outside the test user was read-modified-written
    expect(await othersChecksum(dataSource, userId)).toBe(before);
  });
});
