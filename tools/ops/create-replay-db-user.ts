// Creates (or re-passwords) replay-service's database login, a member of
// forexedge_readonly (the history, its scale and coverage, instruments; migration
// ReadOnlyRole) and forexedge_replay_writer (SELECT, INSERT, UPDATE on the replay_*
// tables; migration ReplayTables). The name and password come from .env
// (REPLAY_DB_USER, REPLAY_DB_PASS); the password is never printed. Then it connects
// as that login and checks what it can and can't read or write: the history and the
// live tables are never writable by it, and it can't read users, orders or the live
// ticks and candles.
//
// From the repo root, after npm run migration:run:
//   npx ts-node --transpile-only tools/ops/create-replay-db-user.ts
import * as path from 'path';
import { Client } from 'pg';

const GROUP_ROLES = ['forexedge_readonly', 'forexedge_replay_writer'];

const ALLOWED = [
  `SELECT count(*)::int AS n FROM historical_candles_1h WHERE pair = 'EUR/USD'`,
  `SELECT count(*)::int AS n FROM historical_coverage`,
  `SELECT count(*)::int AS n FROM instruments`,
  `SELECT count(*)::int AS n FROM replay_sessions`,
  `SELECT count(*)::int AS n FROM replay_positions`,
  // Privileges are checked when a statement is planned, so these prove INSERT and
  // UPDATE without touching a row
  `INSERT INTO replay_sessions SELECT * FROM replay_sessions WHERE false`,
  `UPDATE replay_sessions SET updated_at = updated_at WHERE false`,
  `INSERT INTO replay_positions SELECT * FROM replay_positions WHERE false`,
  `UPDATE replay_positions SET updated_at = updated_at WHERE false`,
];

const REPLAY_DENIED = [
  'SELECT 1 FROM users LIMIT 1',
  'SELECT 1 FROM orders LIMIT 1',
  'SELECT 1 FROM positions LIMIT 1',
  'SELECT 1 FROM account_summary LIMIT 1',
  'SELECT 1 FROM backtest_runs LIMIT 1',
  'SELECT 1 FROM ticks LIMIT 1',
  'SELECT 1 FROM candles_1m LIMIT 1',
  'DELETE FROM replay_sessions WHERE false',
  'DELETE FROM replay_positions WHERE false',
  'INSERT INTO historical_candles SELECT * FROM historical_candles WHERE false',
  'UPDATE historical_candles SET bid_open = bid_open WHERE false',
  'DELETE FROM historical_candles WHERE false',
  'UPDATE historical_price_scale SET pair = pair WHERE false',
  'INSERT INTO historical_import_log SELECT * FROM historical_import_log WHERE false',
  'INSERT INTO ticks SELECT * FROM ticks WHERE false',
  'UPDATE instruments SET pair = pair WHERE false',
];

async function main(): Promise<void> {
  process.loadEnvFile(path.resolve(__dirname, '../../.env'));
  const env = process.env;
  const user = env['REPLAY_DB_USER'];
  const password = env['REPLAY_DB_PASS'];
  if (!user || !password) throw new Error('set REPLAY_DB_USER and REPLAY_DB_PASS in .env');
  if ([env['DB_USER'], env['ML_DB_USER'], env['RESEARCH_DB_USER']].includes(user)) {
    throw new Error('REPLAY_DB_USER must differ from DB_USER, ML_DB_USER and RESEARCH_DB_USER');
  }
  if (password.length < 16) throw new Error('REPLAY_DB_PASS must be at least 16 characters');

  const connection = { host: env['DB_HOST'] || 'localhost', port: Number(env['DB_PORT']), database: env['DB_NAME'] };
  const admin = new Client({ ...connection, user: env['DB_USER'], password: env['DB_PASS'] });
  await admin.connect();
  try {
    for (const group of GROUP_ROLES) {
      const { rows } = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [group]);
      if (rows.length === 0) throw new Error(`role ${group} is missing: run npm run migration:run first`);
    }
    const { rows: existing } = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [user]);
    const id = admin.escapeIdentifier(user);
    const secret = admin.escapeLiteral(password);
    if (existing.length === 0) {
      await admin.query(`CREATE ROLE ${id} LOGIN PASSWORD ${secret} IN ROLE ${GROUP_ROLES.join(', ')}`);
      console.log(`created login ${user} in ${GROUP_ROLES.join(', ')}`);
    } else {
      await admin.query(`ALTER ROLE ${id} LOGIN PASSWORD ${secret}`);
      await admin.query(`GRANT ${GROUP_ROLES.join(', ')} TO ${id}`);
      console.log(`updated login ${user} (password reset, member of ${GROUP_ROLES.join(', ')})`);
    }
  } finally {
    await admin.end();
  }

  const replay = new Client({ ...connection, user, password });
  await replay.connect();
  try {
    for (const sql of ALLOWED) {
      const { rows } = await replay.query(sql);
      console.log(`allowed: ${sql}${rows[0] ? ` -> ${JSON.stringify(rows[0])}` : ''}`);
    }
    const { rows: bars } = await replay.query(ALLOWED[0]);
    if (!(bars[0].n > 0)) throw new Error('the login reads no EUR/USD H1 bars');
    for (const sql of REPLAY_DENIED) {
      try {
        await replay.query(sql);
        throw new Error(`the login was allowed: ${sql}`);
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code !== '42501') throw err; // insufficient_privilege
        console.log(`denied as expected: ${sql}`);
      }
    }
  } finally {
    await replay.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
