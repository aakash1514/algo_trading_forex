// tools/ops/bootstrap-prod.ts against <DB_NAME>_test, twice: both runs succeed and the second changes
// nothing (migrations, instruments, the three logins' roles and grants, the demo user).
//   RUN_DB_TESTS=true npx nx test auth-service --testFile=bootstrap.db.spec.ts --skip-nx-cache
import { spawnSync } from 'child_process';
import { join } from 'path';
import { Client } from 'pg';
import { createTestDatabase, REPO_ROOT, rootEnv, type TestDatabase } from '@forexedge/database/testing';
// test code only: the importer loads real minutes, as replay-service's tests do
// eslint-disable-next-line @nx/enforce-module-boundaries
import { refreshAggregates } from '../../../tools/market-data/import/src/aggregates';
// eslint-disable-next-line @nx/enforce-module-boundaries
import { importPairRange } from '../../../tools/market-data/import/src/importer';
// eslint-disable-next-line @nx/enforce-module-boundaries
import { yearRange } from '../../../tools/market-data/import/src/pairs';

const run = process.env['RUN_DB_TESTS'] === 'true' ? describe : describe.skip;
const DEMO_PASS = 'Bootstrap!Demo-Pass1';

run('bootstrap-prod (real DB, twice)', () => {
  jest.setTimeout(900_000);
  let testDb: TestDatabase;

  beforeAll(async () => { testDb = await createTestDatabase(); });
  afterAll(async () => {
    await testDb?.dataSource.query(`DELETE FROM users WHERE username = 'bootdemo'`).catch(() => undefined);
    await testDb?.drop();
  });

  const bootstrap = () => {
    const env = {
      ...process.env, ...rootEnv(), DB_NAME: testDb.name,
      DEMO_USERS: 'bootdemo', DEMO_BOOTDEMO_EMAIL: 'bootdemo@example.com', DEMO_BOOTDEMO_PASS: DEMO_PASS,
    };
    return spawnSync(process.execPath, [join(REPO_ROOT, 'node_modules/ts-node/dist/bin.js'), '--transpile-only',
      'tools/ops/bootstrap-prod.ts'], { cwd: REPO_ROOT, env, encoding: 'utf8' });
  };

  const state = async () => {
    const q = (sql: string) => testDb.dataSource.query(sql);
    const env = rootEnv();
    const logins = [env['ML_DB_USER'], env['RESEARCH_DB_USER'], env['REPLAY_DB_USER']];
    return {
      migrations: await q('SELECT count(*)::int AS n FROM migrations'),
      instruments: await q('SELECT pair, pip_size::text FROM instruments ORDER BY pair'),
      users: await q('SELECT username, email, role FROM users ORDER BY username'),
      memberships: await q(`SELECT m.rolname AS login, r.rolname AS member_of FROM pg_auth_members a
        JOIN pg_roles r ON r.oid = a.roleid JOIN pg_roles m ON m.oid = a.member
        WHERE m.rolname = ANY($1) ORDER BY 1, 2`.replace('$1', `ARRAY[${logins.map((l) => `'${l}'`).join(',')}]`)),
      connect: await q(`SELECT rolname, has_database_privilege(rolname, current_database(), 'CONNECT') AS ok
        FROM pg_roles WHERE rolname IN (${logins.map((l) => `'${l}'`).join(',')}) ORDER BY 1`),
    };
  };

  // Real Dukascopy minutes (EUR/USD 2022-01-03, the importer's fixture), then the aggregates
  const loadHistory = async () => {
    const client = new Client(testDb.connection);
    await client.connect();
    try {
      const fixture = 'EURUSD-2022-01-03.csv';
      await importPairRange(client, {
        symbol: 'EURUSD', pair: 'EUR/USD', year: 2022,
        range: { start: new Date('2022-01-03T00:00Z'), end: new Date('2022-01-04T00:00Z') },
        file: join(REPO_ROOT, 'tools/market-data/import/src/fixtures', fixture),
        sourceFile: `tools/market-data/import/src/fixtures/${fixture}`,
      });
      await refreshAggregates(client, [yearRange(2022)]);
    } finally {
      await client.end();
    }
  };

  it('without the history it stops before the logins, saying what to run', () => {
    const result = bootstrap();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('[bootstrap] instruments: ok');
    expect(result.stderr).toContain('npm run data:transfer -- import');
    expect(result.stdout).not.toContain('[bootstrap] ML login');
  });

  it('runs every step, then again with the same result', async () => {
    await loadHistory();
    const first = bootstrap();
    if (first.status !== 0) throw new Error(`bootstrap failed:
${first.stdout.slice(-2500)}
${first.stderr.slice(-2500)}`);
    for (const step of ['migrations', 'instruments', 'history loaded', 'ML login', 'research login', 'replay login', 'demo users']) {
      expect(first.stdout).toContain(`[bootstrap] ${step}: ok`);
    }
    expect(first.stdout + first.stderr).not.toContain(DEMO_PASS);
    const after1 = await state();
    expect(after1.instruments.length).toBeGreaterThan(0);
    expect(after1.users).toEqual([{ username: 'bootdemo', email: 'bootdemo@example.com', role: expect.any(String) }]);
    expect(after1.memberships.length).toBeGreaterThanOrEqual(3);
    expect(after1.connect.every((r: { ok: boolean }) => r.ok)).toBe(true);

    const second = bootstrap();
    if (second.status !== 0) throw new Error(`second run failed:
${second.stdout.slice(-2500)}
${second.stderr.slice(-2500)}`);
    expect(second.stdout).toContain('already there bootdemo');
    expect(await state()).toEqual(after1);
  });

  it('a failing step stops the rest', () => {
    const env = { ...process.env, ...rootEnv(), DB_NAME: testDb.name, ML_DB_PASS: 'short' };
    const result = spawnSync(process.execPath, [join(REPO_ROOT, 'node_modules/ts-node/dist/bin.js'), '--transpile-only',
      'tools/ops/bootstrap-prod.ts'], { cwd: REPO_ROOT, env, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('[bootstrap] ML login failed');
    expect(result.stdout).not.toContain('[bootstrap] research login');
  });
});
