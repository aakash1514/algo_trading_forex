// GET /api/backtest/:runId/results over real HTTP, through the real JwtAuthGuard and JwtStrategy, with
// the BacktestService on a real backtest_runs table in <DB_NAME>_test: the user id comes from the verified
// token (req.user.id = sub), and another user's run is a 404 without the result store being read.
//   RUN_DB_TESTS=true npx nx test ws-gateway --testFile=backtest-results.db.spec.ts --skip-nx-cache
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ACCESS_TOKEN_SIGN_OPTIONS } from '@forexedge/common';
import { BacktestRunEntity, UserEntity } from '@forexedge/database';
import { createTestDatabase, type TestDatabase } from '@forexedge/database/testing';
import { AuthModule } from '../auth/auth.module';
import { BACKTEST_QUEUE } from './backtest-queue.module';
import { BacktestController } from './backtest.controller';
import { BacktestService } from './backtest.service';
import { BACKTEST_RESULT_STORE } from './result-store';

const run = process.env['RUN_DB_TESTS'] === 'true' ? describe : describe.skip;
const SECRET = 'test-access-secret-long-enough-for-hs256';
const RESULTS = Buffer.from('{"trades":[{"entryPoints":112035,"exitPoints":111932}]}');

run('backtest results: owner only (real HTTP, guard and DB)', () => {
  jest.setTimeout(120_000);
  let testDb: TestDatabase;
  let app: INestApplication;
  let url: string;
  const reads: string[] = [];
  const previousSecret = process.env['JWT_ACCESS_SECRET'];
  let owner: string;
  let other: string;
  let runId: string;

  const token = (sub: string) =>
    new JwtService().sign({ sub, email: `${sub}@example.com`, role: 'TRADER' }, { ...ACCESS_TOKEN_SIGN_OPTIONS, secret: SECRET, expiresIn: 300 });
  const get = (path: string, sub?: string) =>
    fetch(`${url}/api/backtest${path}`, { headers: sub ? { Authorization: `Bearer ${token(sub)}` } : {} });

  beforeAll(async () => {
    process.env['JWT_ACCESS_SECRET'] = SECRET; // JwtStrategy reads it when the module is built
    testDb = await createTestDatabase();
    const q = (sql: string, params: unknown[] = []) => testDb.dataSource.query(sql, params);
    [{ id: owner }] = await q(`INSERT INTO users (email, username, password_hash) VALUES ('owner@example.com', 'owner_u', 'x') RETURNING id`);
    [{ id: other }] = await q(`INSERT INTO users (email, username, password_hash) VALUES ('other@example.com', 'other_u', 'x') RETURNING id`);
    [{ id: runId }] = await q(
      `INSERT INTO backtest_runs (user_id, strategy_name, instrument, timeframe, from_date, to_date, status, initial_capital, lots,
         minio_object_key)
       VALUES ($1, 'ma_crossover', 'EUR_USD', '1h', '2022-01-03', '2022-01-31', 'COMPLETED', 10000, 0.1, 'owner-run/results.json')
       RETURNING id`, [owner]);

    const { connection: c } = testDb;
    const moduleRef = await Test.createTestingModule({
      imports: [
        AuthModule,
        TypeOrmModule.forRoot({
          type: 'postgres', host: c.host, port: c.port, username: c.user, password: c.password, database: c.database,
          entities: [BacktestRunEntity, UserEntity], synchronize: false,
        }),
        TypeOrmModule.forFeature([BacktestRunEntity]),
      ],
      controllers: [BacktestController],
      providers: [
        BacktestService,
        { provide: BACKTEST_QUEUE, useValue: {} },
        { provide: BACKTEST_RESULT_STORE, useValue: { read: async (key: string) => { reads.push(key); return RESULTS; } } },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
    await testDb?.drop();
    process.env['JWT_ACCESS_SECRET'] = previousSecret;
  });

  it('runs in a _test database', async () => {
    expect((await testDb.dataSource.query('SELECT current_database() AS db'))[0].db).toMatch(/_test$/);
  });

  it("another user's run is a 404, and the store is never read", async () => {
    const res = await get(`/${runId}/results`, other);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('trades');
    expect(reads).toEqual([]);
  });

  it('no token, or a forged one, is a 401', async () => {
    expect((await get(`/${runId}/results`)).status).toBe(401);
    const forged = new JwtService().sign({ sub: owner }, { ...ACCESS_TOKEN_SIGN_OPTIONS, secret: 'not-the-secret-long-enough', expiresIn: 300 });
    const res = await fetch(`${url}/api/backtest/${runId}/results`, { headers: { Authorization: `Bearer ${forged}` } });
    expect(res.status).toBe(401);
    expect(reads).toEqual([]);
  });

  it('the owner gets results.json, read with the run\'s own key', async () => {
    const res = await get(`/${runId}/results`, owner);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(RESULTS);
    expect(reads).toEqual(['owner-run/results.json']);
  });
});
