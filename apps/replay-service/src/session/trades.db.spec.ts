// Closed-trade paging through the real replay-service (HTTP + socket)
// against a real database: <DB_NAME>_test with the real EUR/USD minutes of 2022-01-03,
// trades made by placing, stepping and closing like a user. Skipped unless RUN_DB_TESTS=true:
//   RUN_DB_TESTS=true npx nx test replay-service --testFile=trades.db.spec.ts --skip-nx-cache
import { createReplayTestDb, EURUSD_2022_01_03, ReplayTestDb } from '../../test/replay-test-db';
import { accessToken, connectClient, http, ReplayApp, ReplayClient, startReplayApp } from '../../test/replay-app';
import type { PositionView } from './position.view';
import type { TradesPage } from './trades.service';

const run = process.env['RUN_DB_TESTS'] === 'true' ? describe : describe.skip;

const BATCH = 25;

run('closed trades (real DB, real minutes, replay login)', () => {
  jest.setTimeout(300_000);
  let db: ReplayTestDb;
  let app: ReplayApp;
  let owner: string;
  let other: string;
  let sessionId: string;
  let client: ReplayClient;

  const as = (userId: string) => accessToken(userId);
  const get = <T,>(userId: string, path: string) => http<T>(app.url, as(userId), 'GET', path);
  const step = async (n = 1) => {
    for (let i = 0; i < n; i += 1) {
      const ack = await client.command('step');
      if (!ack.ok) throw new Error(`step: ${ack.error}`);
    }
  };
  const closedInOrder = async (): Promise<string[]> => (await db.admin.query(
    `SELECT id FROM replay_positions WHERE session_id = $1 AND status = 'CLOSED' ORDER BY exit_time DESC, id DESC`,
    [sessionId])).map((r: { id: string }) => r.id);
  const allPages = async () => {
    const ids: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res: { status: number; body: TradesPage } = await get<TradesPage>(owner,
        `/sessions/${sessionId}/trades${cursor ? `?cursor=${cursor}` : ''}`);
      expect(res.status).toBe(200);
      ids.push(...res.body.trades.map((t) => t.id));
      cursor = res.body.nextCursor;
      pages += 1;
    } while (cursor && pages < 20);
    return { ids, pages };
  };

  beforeAll(async () => {
    db = await createReplayTestDb([EURUSD_2022_01_03]);
    app = await startReplayApp(db);
    owner = await db.createUser();
    other = await db.createUser();
    const created = await http<{ id: string }>(app.url, as(owner), 'POST', '/sessions',
      { instrument: 'EUR_USD', startTime: '2022-01-03T09:30Z', timeframe: '1m', startingBalance: 10000 });
    expect(created.status).toBe(201);
    sessionId = created.body.id;
    client = await connectClient(app.url, as(owner));

    // 26 market orders of 0.1 lots, half long and half short, filled at the next minute
    const ids: string[] = [];
    for (let i = 0; i <= BATCH; i += 1) {
      const res = await http<{ position: PositionView }>(app.url, as(owner), 'POST', '/sessions/active/orders',
        { side: i % 2 === 0 ? 'BUY' : 'SELL', lots: 0.1 });
      expect(res.status).toBe(201);
      ids.push(res.body.position.id);
    }
    await step(30);
    // 25 closes requested at one clock minute: all close at the next minute's open, at one exit_time
    for (const id of ids.slice(0, BATCH)) {
      expect((await http(app.url, as(owner), 'POST', `/sessions/active/positions/${id}/close`)).status).toBe(200);
    }
    await step();
  });

  afterAll(async () => {
    await client?.close();
    await app?.close();
    await db?.close();
  });

  it('pages of 20 newest first through 25 trades that closed in the same minute: every trade once, in order', async () => {
    const [{ times }] = await db.admin.query(
      `SELECT count(DISTINCT exit_time)::int AS times FROM replay_positions WHERE session_id = $1 AND status = 'CLOSED'`,
      [sessionId]);
    expect(times).toBe(1); // the tie the id has to break
    const expected = await closedInOrder();
    expect(expected).toHaveLength(BATCH);
    const { ids, pages } = await allPages();
    expect(pages).toBe(2);
    expect(ids).toEqual(expected);
  });

  it('a trade closing between two pages does not change the next page; it is on top of a fresh first page', async () => {
    const first = await get<TradesPage>(owner, `/sessions/${sessionId}/trades`);
    expect(first.body.trades).toHaveLength(20);
    const second = async () => (await get<TradesPage>(owner, `/sessions/${sessionId}/trades?cursor=${first.body.nextCursor}`)).body;
    const before = await second();

    const [last] = await db.admin.query(
      `SELECT id FROM replay_positions WHERE session_id = $1 AND status = 'OPEN'`, [sessionId]);
    expect((await http(app.url, as(owner), 'POST', `/sessions/active/positions/${last.id}/close`)).status).toBe(200);
    await step(3);

    expect(await second()).toEqual(before);
    expect(before.trades.map((t) => t.id)).toEqual((await closedInOrder()).slice(21));
    const fresh = (await get<TradesPage>(owner, `/sessions/${sessionId}/trades`)).body;
    expect(fresh.trades[0].id).toBe(last.id);
    expect((await allPages()).ids).toEqual(await closedInOrder());
  });

  it('an empty session has no closed trades', async () => {
    const created = await http<{ id: string }>(app.url, as(other), 'POST', '/sessions',
      { instrument: 'EUR_USD', startTime: '2022-01-03T12:00Z', timeframe: '1m', startingBalance: 5000 });
    expect(created.status).toBe(201);
    const trades = await get<TradesPage>(other, `/sessions/${created.body.id}/trades`);
    expect(trades.body).toEqual({ trades: [], nextCursor: null });
  });

  it('another user’s session is a 404; a bad id or cursor is a 400', async () => {
    expect((await get(other, `/sessions/${sessionId}/trades`)).status).toBe(404);
    expect((await get(owner, `/sessions/00000000-0000-4000-8000-000000000000/trades`)).status).toBe(404);
    expect((await get(owner, `/sessions/not-a-uuid/trades`)).status).toBe(400);
    expect((await get(owner, `/sessions/${sessionId}/trades?cursor=bm90LWpzb24`)).status).toBe(400);
  });
});
