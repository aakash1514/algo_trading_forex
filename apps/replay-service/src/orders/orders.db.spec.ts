// Replay orders against a real database: <DB_NAME>_test with the real EUR/USD and
// XAU/USD minutes of 2022-01-03, the services connected as a login with
// forexedge_replay's grants. SL/TP levels are the test's choices; every price they are
// compared with, and every fill, comes from the real minutes. Skipped unless RUN_DB_TESTS=true:
//   RUN_DB_TESTS=true npx nx test replay-service --testFile=orders.db.spec.ts --skip-nx-cache
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { markToMarketCents, marginRequiredCents, tradeMoney } from '@forexedge/trading-sim';
import { ReplayPositionEntity, ReplaySessionEntity } from '@forexedge/database';
import { createReplayTestDb, EURUSD_2022_01_03, ReplayTestDb, XAUUSD_2022_01_03 } from '../../test/replay-test-db';
import { replayServices, ReplayServices } from '../../test/replay-services';
import { minuteAt } from '../history/replay-history';

const run = process.env['RUN_DB_TESTS'] === 'true' ? describe : describe.skip;

const EUR_SPEC = { lotSize: 100_000, pipSize: 0.0001, maxLeverage: null };
const GOLD_SPEC = { lotSize: 100, pipSize: 0.01, maxLeverage: 20 };
const EUR_MONEY = { pair: 'EUR/USD', units: 10_000, priceDecimals: 5, pipPoints: 10 };
const usd = (cents: bigint) => {
  const sign = cents < 0n ? '-' : '';
  const abs = cents < 0n ? -cents : cents;
  return `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
};
const eur = (points: number) => Number((points / 1e5).toFixed(5));

run('replay orders (real DB, real minutes, replay login)', () => {
  jest.setTimeout(180_000);
  let db: ReplayTestDb;
  let svc: ReplayServices;

  const start = async (startTime: string, over: Record<string, unknown> = {}) => {
    const userId = await db.createUser();
    const session = await svc.sessions.create(userId, { instrument: 'EUR_USD', startTime, timeframe: '1m', ...over } as never);
    return { userId, session };
  };
  const minute = (pair: string, iso: string) => minuteAt(db.admin, pair, new Date(iso));
  const nextMinute = async (pair: string, iso: string) => {
    const [{ t }] = await db.admin.query('SELECT min(time) AS t FROM historical_candles WHERE pair = $1 AND time > $2', [pair, iso]);
    return minuteAt(db.admin, pair, new Date(t));
  };
  const row = (id: string) => db.admin.getRepository(ReplayPositionEntity).findOneByOrFail({ id });

  beforeAll(async () => {
    db = await createReplayTestDb([EURUSD_2022_01_03, XAUUSD_2022_01_03]);
    svc = replayServices(db);
  });

  afterAll(async () => {
    await svc?.playback.onModuleDestroy();
    await db?.close();
  });

  it('places a PENDING order at the clock, with margin at the ask close; it fills at the next minute open', async () => {
    const { userId, session } = await start('2022-01-03T09:30Z');
    const clock = await minute('EUR/USD', session.clockTime);
    const sl = clock.bid.close - 80;
    const tp = clock.bid.close + 80;
    const placed = await svc.orders.place(userId, { side: 'BUY', lots: 0.1, stopLoss: eur(sl), takeProfit: eur(tp) });
    const margin = marginRequiredCents({ pair: 'EUR/USD', lots: 0.1, spec: EUR_SPEC, pricePoints: clock.ask.close, priceDecimals: 5 });
    expect(placed.position).toMatchObject({
      side: 'BUY', lots: '0.10', units: 10_000, status: 'PENDING', placedAt: session.clockTime,
      stopLoss: (sl / 1e5).toFixed(5), takeProfit: (tp / 1e5).toFixed(5), marginUsd: usd(margin), entryTime: null,
    });
    expect(placed.account).toMatchObject({
      balance: '10000.00', equity: '10000.00', marginUsed: usd(margin), freeMargin: usd(1_000_000n - margin), pendingOrders: 1,
    });

    const step = await svc.playback.step(userId);
    const fill = await nextMinute('EUR/USD', session.clockTime);
    expect(step.session.clockTime).toBe(fill.time.toISOString());
    const filled = await row(placed.position.id);
    expect([filled.status, filled.entryTime?.toISOString(), filled.entryPoints]).toEqual(['OPEN', fill.time.toISOString(), fill.ask.open]);

    // Equity = balance + the open position marked at the clock minute's close (bid for a long)
    const account = await svc.state.account(await db.admin.getRepository(ReplaySessionEntity).findOneByOrFail({ id: session.id }));
    const unrealized = markToMarketCents('BUY', fill.ask.open, fill.bid.close, EUR_MONEY);
    expect(account).toMatchObject({
      balance: '10000.00', unrealizedPnlUsd: usd(unrealized), equity: usd(1_000_000n + unrealized), openPositions: 1, pendingOrders: 0,
    });
    await svc.sessions.end(userId);
  });

  it.each([
    ['BUY', 'stopLoss above the bid', (c: { bid: number; ask: number }) => ({ stopLoss: eur(c.bid + 1) }), 'must be below the bid'],
    ['BUY', 'stopLoss at the bid', (c: { bid: number; ask: number }) => ({ stopLoss: eur(c.bid) }), 'must be below the bid'],
    ['BUY', 'takeProfit below the bid', (c: { bid: number; ask: number }) => ({ takeProfit: eur(c.bid - 1) }), 'must be above the bid'],
    ['SELL', 'stopLoss below the ask', (c: { bid: number; ask: number }) => ({ stopLoss: eur(c.ask - 1) }), 'must be above the ask'],
    ['SELL', 'takeProfit above the ask', (c: { bid: number; ask: number }) => ({ takeProfit: eur(c.ask + 1) }), 'must be below the ask'],
    ['BUY', 'a level finer than a point', (c: { bid: number; ask: number }) => ({ stopLoss: eur(c.bid - 50) + 0.000001 }),
      'at most 5 decimals'],
  ] as const)('%s with %s is refused (400) and nothing is saved', async (side, _case, levels, message) => {
    const { userId, session } = await start('2022-01-03T11:00Z');
    const clock = await minute('EUR/USD', session.clockTime);
    const err = await svc.orders.place(userId, { side, lots: 0.1, ...levels({ bid: clock.bid.close, ask: clock.ask.close }) })
      .catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toContain(message);
    const [{ n }] = await db.admin.query('SELECT count(*)::int AS n FROM replay_positions WHERE session_id = $1', [session.id]);
    expect(n).toBe(0);
    await svc.sessions.end(userId);
  });

  it('refuses an order beyond the free margin; cancelling a pending order releases its margin', async () => {
    const { userId, session } = await start('2022-01-03T12:00Z', { startingBalance: 100 });
    const clock = await minute('EUR/USD', session.clockTime);
    const marginOf = (lots: number) =>
      marginRequiredCents({ pair: 'EUR/USD', lots, spec: EUR_SPEC, pricePoints: clock.ask.close, priceDecimals: 5 });
    const big = await svc.orders.place(userId, { side: 'BUY', lots: 1 }).catch((e) => e);
    expect(big).toBeInstanceOf(BadRequestException);
    expect(big.message).toBe(`Insufficient margin: need $${usd(marginOf(1))}, free margin $100.00`);

    const first = await svc.orders.place(userId, { side: 'BUY', lots: 0.08 });
    expect(first.account.freeMargin).toBe(usd(10_000n - marginOf(0.08)));
    const second = await svc.orders.place(userId, { side: 'BUY', lots: 0.01 }).catch((e) => e);
    expect(second.message).toBe(`Insufficient margin: need $${usd(marginOf(0.01))}, free margin $${usd(10_000n - marginOf(0.08))}`);

    const cancelled = await svc.orders.cancel(userId, first.position.id);
    expect(cancelled.position).toMatchObject({ status: 'CANCELLED', entryTime: null });
    expect(cancelled.account).toMatchObject({ marginUsed: '0.00', freeMargin: '100.00', pendingOrders: 0 });
    expect((await svc.orders.place(userId, { side: 'BUY', lots: 0.01 })).position.status).toBe('PENDING');

    // A cancelled order never fills
    await svc.playback.step(userId);
    expect((await row(first.position.id)).status).toBe('CANCELLED');
    await svc.sessions.end(userId);
  });

  it('XAU/USD margin uses the instrument cap (1:20) at the bid close for a SELL', async () => {
    const { userId, session } = await start('2022-01-03T15:00Z', { instrument: 'XAU_USD' });
    const clock = await minute('XAU/USD', session.clockTime);
    const placed = await svc.orders.place(userId, { side: 'SELL', lots: 0.1 });
    const margin = marginRequiredCents({ pair: 'XAU/USD', lots: 0.1, spec: GOLD_SPEC, pricePoints: clock.bid.close, priceDecimals: 3 });
    // The same as an uncapped 1:20 account, a fifth of the 1:100 margin
    expect(margin).toBe(marginRequiredCents({ pair: 'XAU/USD', lots: 0.1, spec: { ...GOLD_SPEC, maxLeverage: null },
      pricePoints: clock.bid.close, priceDecimals: 3, accountLeverage: 20 }));
    expect(margin).toBeGreaterThan(4n * marginRequiredCents({ pair: 'XAU/USD', lots: 0.1, spec: { ...GOLD_SPEC, maxLeverage: null },
      pricePoints: clock.bid.close, priceDecimals: 3 }));
    expect(placed.position.marginUsd).toBe(usd(margin));
    await svc.sessions.end(userId);
  });

  it('cancel: only a PENDING order of my own session', async () => {
    const { userId } = await start('2022-01-03T13:00Z');
    const other = await start('2022-01-03T13:00Z');
    const order = await svc.orders.place(userId, { side: 'SELL', lots: 0.1 });
    const theirs = await svc.orders.place(other.userId, { side: 'SELL', lots: 0.1 });
    await expect(svc.orders.cancel(userId, theirs.position.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.orders.cancel(userId, '00000000-0000-4000-8000-000000000000')).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.orders.cancel(userId, 'not-an-id')).rejects.toBeInstanceOf(NotFoundException);
    await svc.playback.step(userId); // fills
    const err = await svc.orders.cancel(userId, order.position.id).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toBe('The order has already filled');
    const pending = await svc.orders.place(userId, { side: 'BUY', lots: 0.1 });
    await svc.orders.cancel(userId, pending.position.id);
    await expect(svc.orders.cancel(userId, pending.position.id)).rejects.toThrow('already cancelled');
    await svc.sessions.end(userId);
    await svc.sessions.end(other.userId);
  });

  it('a manual close is pending at the clock and fills at the next minute open (MANUAL), money to the cent', async () => {
    const { userId } = await start('2022-01-03T14:10Z');
    const order = await svc.orders.place(userId, { side: 'SELL', lots: 0.1 });
    await expect(svc.orders.close(userId, order.position.id)).rejects.toThrow('cancel it instead');
    const filled = (await svc.playback.step(userId)).session.clockTime;
    await svc.playback.step(userId);
    const s1 = await svc.sessions.getActive(userId);
    const requested = await svc.orders.close(userId, order.position.id);
    expect(requested.position).toMatchObject({ status: 'OPEN', exitRequestedAt: s1.clockTime });
    await expect(svc.orders.close(userId, order.position.id)).rejects.toThrow('already pending');

    await svc.playback.step(userId);
    const exit = await nextMinute('EUR/USD', s1.clockTime);
    const entry = await minute('EUR/USD', filled);
    const closed = await row(order.position.id);
    const net = tradeMoney({ action: 'SELL', entryPoints: entry.bid.open, exitPoints: exit.ask.open }, EUR_MONEY).netUsd;
    expect([closed.status, closed.exitReason, closed.exitTime?.toISOString(), closed.exitPoints, Number(closed.realizedPnlUsd)])
      .toEqual(['CLOSED', 'MANUAL', exit.time.toISOString(), exit.ask.open, net]);
    const after = await svc.sessions.getActive(userId);
    expect(after.balance).toBe((10_000 + net).toFixed(2));
    await expect(svc.orders.close(userId, order.position.id)).rejects.toThrow('already CLOSED');
    await svc.sessions.end(userId);
  });

  it('orders work while PLAYING: the next timer step fills them', async () => {
    const { userId } = await start('2022-01-03T16:00Z');
    await svc.playback.setSpeed(userId, 500);
    await svc.playback.play(userId);
    const order = await svc.orders.place(userId, { side: 'BUY', lots: 0.1 });
    const until = Date.now() + 5_000;
    while ((await row(order.position.id)).status === 'PENDING' && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await svc.playback.pause(userId);
    const filled = await row(order.position.id);
    expect(filled.status).toBe('OPEN');
    expect(filled.entryTime?.getTime()).toBeGreaterThan(filled.placedAt.getTime());
    const fill = await nextMinute('EUR/USD', filled.placedAt.toISOString());
    expect([filled.entryTime?.toISOString(), filled.entryPoints]).toEqual([fill.time.toISOString(), fill.ask.open]);
    await svc.sessions.end(userId);
  });

  it('at the end of the data an order can never fill: 409', async () => {
    const { userId } = await start('2022-01-04T12:00Z');
    await expect(svc.orders.place(userId, { side: 'BUY', lots: 0.1 })).rejects.toThrow('End of data');
    await svc.sessions.end(userId);
  });

  it('without an active session: 404', async () => {
    const userId = await db.createUser();
    await expect(svc.orders.place(userId, { side: 'BUY', lots: 0.1 })).rejects.toBeInstanceOf(NotFoundException);
  });
});
