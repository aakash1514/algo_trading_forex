// Integration tests run against their own database, never the development one:
// <DB_NAME>_test (e.g. forexedge_test; forexedge_w2_test for a second Jest
// worker) is dropped, created and migrated from
// scratch on every run, and nothing connects unless the name ends in "_test".
// (A test that shared the development database once marked and stopped out
// real positions.)
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DataSource, type DataSourceOptions } from 'typeorm';
import {
  AccountSummaryEntity, BacktestRunEntity, EconomicEventEntity, InstrumentEntity, OrderEntity, PositionEntity,
  ReplayPositionEntity, ReplaySessionEntity, SwapRateEntity, UserEntity,
} from '../index';

// The repo root holds nx.json, the only .env and the migrations.
function findRepoRoot(from: string): string {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'nx.json'))) return dir;
    if (dirname(dir) === dir) throw new Error(`No nx.json above ${from}`);
  }
}

export const REPO_ROOT = findRepoRoot(__dirname);

export function rootEnv(): Record<string, string> {
  const text = readFileSync(join(REPO_ROOT, '.env'), 'utf8');
  return Object.fromEntries(text.split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
}

export function assertTestDatabaseName(name: string): void {
  if (!/_test$/.test(name)) {
    throw new Error(`Refusing to use database "${name}" for tests: its name must end in "_test"`);
  }
}

export interface TestDatabaseConnection {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export interface TestDatabase {
  dataSource: DataSource;
  name: string;
  // For clients other than TypeORM (e.g. pg, used by the historical importer)
  connection: TestDatabaseConnection;
  drop(): Promise<void>;
}

// Drops, creates and migrates the test database, and returns a connection to it.
export async function createTestDatabase(): Promise<TestDatabase> {
  const env = rootEnv();
  // One database per Jest worker: suites run in parallel and each drops and
  // recreates its database (forexedge_test, forexedge_w2_test, ...).
  const worker = Number(process.env['JEST_WORKER_ID'] ?? '1');
  const name = env['TEST_DB_NAME'] || `${env['DB_NAME']}${worker > 1 ? `_w${worker}` : ''}_test`;
  assertTestDatabaseName(name);

  const connection: TestDatabaseConnection = {
    host: env['DB_HOST'] || 'localhost',
    port: Number(env['DB_PORT']),
    user: env['DB_USER'],
    password: env['DB_PASS'],
    database: name,
  };
  const server: DataSourceOptions = {
    type: 'postgres',
    host: connection.host,
    port: connection.port,
    username: connection.user,
    password: connection.password,
  };

  // CREATE/DROP DATABASE run from the server's maintenance database
  const admin = new DataSource({ ...server, database: 'postgres' });
  await admin.initialize();
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.destroy();

  const dataSource = new DataSource({
    ...server,
    database: name,
    entities: [UserEntity, InstrumentEntity, SwapRateEntity, EconomicEventEntity, OrderEntity, PositionEntity,
      AccountSummaryEntity, BacktestRunEntity, ReplaySessionEntity, ReplayPositionEntity],
    migrations: [join(REPO_ROOT, 'apps/auth-service/src/migrations/*.ts')],
    synchronize: false,
    logging: false,
  });
  await dataSource.initialize();
  assertTestDatabaseName(dataSource.options.database as string);
  await dataSource.runMigrations({ transaction: 'each' });

  return {
    dataSource,
    name,
    connection,
    async drop() {
      if (dataSource.isInitialized) await dataSource.destroy();
      const cleanup = new DataSource({ ...server, database: 'postgres' });
      await cleanup.initialize();
      await cleanup.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await cleanup.destroy();
    },
  };
}
