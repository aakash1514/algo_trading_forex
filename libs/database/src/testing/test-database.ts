// Integration tests run against their own database, never the development one:
// <DB_NAME>_test (e.g. forexedge_test) is dropped, created and migrated from
// scratch on every run, and nothing connects unless the name ends in "_test".
// (A test that shared the development database once marked and stopped out
// real positions.)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource, type DataSourceOptions } from 'typeorm';
import {
  AccountSummaryEntity, BacktestRunEntity, EconomicEventEntity, InstrumentEntity, OrderEntity, PositionEntity,
  SwapRateEntity, UserEntity,
} from '@forexedge/database';

const REPO_ROOT = join(__dirname, '../../../..');

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

export interface TestDatabase {
  dataSource: DataSource;
  name: string;
  drop(): Promise<void>;
}

// Drops, creates and migrates the test database, and returns a connection to it.
export async function createTestDatabase(): Promise<TestDatabase> {
  const env = rootEnv();
  const name = env['TEST_DB_NAME'] || `${env['DB_NAME']}_test`;
  assertTestDatabaseName(name);

  const server: DataSourceOptions = {
    type: 'postgres',
    host: env['DB_HOST'] || 'localhost',
    port: Number(env['DB_PORT']),
    username: env['DB_USER'],
    password: env['DB_PASS'],
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
      AccountSummaryEntity, BacktestRunEntity],
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
    async drop() {
      if (dataSource.isInitialized) await dataSource.destroy();
      const cleanup = new DataSource({ ...server, database: 'postgres' });
      await cleanup.initialize();
      await cleanup.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await cleanup.destroy();
    },
  };
}
