// DB-test harness for replay-service. Builds <DB_NAME>_test (dropped, created and
// migrated per run; never the development database) with:
//   - the real instruments seed (apps/auth-service seeds, the same contract specs as dev)
//   - real Dukascopy M1 excerpts, loaded by the historical importer (the one
//     legitimate writer of historical_*), and their aggregates refreshed
//   - a temporary login in forexedge_readonly + forexedge_replay_writer, the same
//     grants as forexedge_replay, which the services under test connect as: they get
//     exactly production's rights (history and instruments read-only, replay_* only
//     written)
// Test code only: the importer and the seed are application code, so these imports
// cross a project boundary on purpose (lint exception below, nowhere else).
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { ReplayPositionEntity, ReplaySessionEntity } from '@forexedge/database';
import { createTestDatabase, REPO_ROOT, type TestDatabase } from '@forexedge/database/testing';
// eslint-disable-next-line @nx/enforce-module-boundaries
import { importPairRange } from '../../../tools/market-data/import/src/importer';
// eslint-disable-next-line @nx/enforce-module-boundaries
import { refreshAggregates } from '../../../tools/market-data/import/src/aggregates';
// eslint-disable-next-line @nx/enforce-module-boundaries
import { seedInstruments } from '../../auth-service/src/seeds/instruments.seed';

export const FIXTURES = join(REPO_ROOT, 'tools/market-data/import/src/fixtures');

// A real Dukascopy excerpt (the importer's verbatim fixtures)
export interface HistoryExcerpt {
  symbol: string;  // EURUSD
  pair: string;    // EUR/USD
  file: string;    // in FIXTURES
  range: { start: Date; end: Date };
}

// Monday 2022-01-03, 00:00-24:00 UTC: 1,425 traded EUR/USD minutes, including the
// 22:00 UTC New York close (an H4 and a D1 boundary) and several H4 boundaries
export const EURUSD_2022_01_03: HistoryExcerpt = {
  symbol: 'EURUSD', pair: 'EUR/USD', file: 'EURUSD-2022-01-03.csv',
  range: { start: new Date('2022-01-03T00:00Z'), end: new Date('2022-01-04T00:00Z') },
};

export const XAUUSD_2022_01_03: HistoryExcerpt = {
  symbol: 'XAUUSD', pair: 'XAU/USD', file: 'XAUUSD-2022-01-03.csv',
  range: { start: new Date('2022-01-03T00:00Z'), end: new Date('2022-01-04T00:00Z') },
};

export interface ReplayTestDb {
  testDb: TestDatabase;
  admin: DataSource;   // the migrating user, for setup and assertions only
  replay: DataSource;  // the replay login: what the services under test use
  createUser(): Promise<string>;
  close(): Promise<void>;
}

export async function createReplayTestDb(excerpts: HistoryExcerpt[]): Promise<ReplayTestDb> {
  if (excerpts.length === 0) throw new Error('a replay test needs real history');
  const testDb = await createTestDatabase();
  const admin = testDb.dataSource;
  await seedInstruments(admin);

  const client = new Client(testDb.connection);
  await client.connect();
  try {
    for (const e of excerpts) {
      const result = await importPairRange(client, {
        symbol: e.symbol, pair: e.pair, year: e.range.start.getUTCFullYear(),
        file: join(FIXTURES, e.file), sourceFile: `tools/market-data/import/src/fixtures/${e.file}`, range: e.range,
      });
      if (!(result.importedRows > 0)) throw new Error(`no rows imported from ${e.file}`);
    }
    await refreshAggregates(client, excerpts.map((e) => e.range));
  } finally {
    await client.end();
  }

  // Roles are cluster-wide: a uniquely named login, dropped again in close()
  const login = `forexedge_replay_t${randomBytes(4).toString('hex')}`;
  const password = randomBytes(18).toString('base64url');
  await admin.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}' IN ROLE forexedge_readonly, forexedge_replay_writer`);
  const replay = new DataSource({
    type: 'postgres', host: testDb.connection.host, port: testDb.connection.port,
    username: login, password, database: testDb.name,
    entities: [ReplaySessionEntity, ReplayPositionEntity], synchronize: false, logging: false,
  });
  await replay.initialize();

  let users = 0;
  return {
    testDb, admin, replay,
    async createUser() {
      const tag = `${Date.now()}_${++users}`;
      const [{ id }] = await admin.query(
        `INSERT INTO users (email, username, password_hash, first_name, last_name)
         VALUES ($1, $2, 'not-a-real-hash', 'Replay', 'Test') RETURNING id`, [`replay${tag}@example.com`, `replay_${tag}`]);
      return id as string;
    },
    async close() {
      if (replay.isInitialized) await replay.destroy();
      await testDb.drop();
      // The test database is gone, so the login owns nothing and has no grants left
      const server = new Client({ ...testDb.connection, database: 'postgres' });
      await server.connect();
      try {
        await server.query(`DROP ROLE IF EXISTS ${login}`);
      } finally {
        await server.end();
      }
    },
  };
}
