// Creates (or re-passwords) the research agent's database login, a member of the
// read-only group roles forexedge_readonly (history; migration ReadOnlyRole) and
// forexedge_research_reader (some backtest_runs columns; migration ResearchReadRole).
// The name and password come from .env (RESEARCH_DB_USER, RESEARCH_DB_PASS); the
// password is never printed. Then it connects as that login and checks what it can
// and can't read or write.
//
// From the repo root, after npm run migration:run:
//   npx ts-node --transpile-only tools/ops/create-research-db-user.ts
import { existsSync } from 'fs';
import * as path from 'path';
import { Client } from 'pg';

const GROUP_ROLES = ['forexedge_readonly', 'forexedge_research_reader'];

const ALLOWED_READS = [
  `SELECT count(*)::int AS n FROM historical_candles_1h WHERE pair = 'EUR/USD'`,
  `SELECT count(*)::int AS n FROM historical_coverage`,
  `SELECT count(*)::int AS n FROM instruments`,
  `SELECT count(id)::int AS n, count(total_pnl_usd) AS usd, max(completed_at) AS last FROM backtest_runs`,
];

const DENIED = [
  'SELECT minio_object_key FROM backtest_runs LIMIT 1',
  'SELECT error_message FROM backtest_runs LIMIT 1',
  'SELECT * FROM backtest_runs LIMIT 1',
  'SELECT 1 FROM users LIMIT 1',
  'SELECT 1 FROM orders LIMIT 1',
  'SELECT 1 FROM positions LIMIT 1',
  'SELECT 1 FROM account_summary LIMIT 1',
  'DELETE FROM historical_candles WHERE false',
  'UPDATE backtest_runs SET status = status WHERE false',
  'INSERT INTO backtest_runs (id) SELECT id FROM backtest_runs WHERE false',
  'DELETE FROM backtest_runs WHERE false',
];

async function main(): Promise<void> {
  // the repo's .env on a laptop; a container passes the variables instead
  const envFile = path.resolve(__dirname, '../../.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const env = process.env;
  const user = env['RESEARCH_DB_USER'];
  const password = env['RESEARCH_DB_PASS'];
  if (!user || !password) throw new Error('set RESEARCH_DB_USER and RESEARCH_DB_PASS in .env');
  if (user === env['DB_USER'] || user === env['ML_DB_USER']) {
    throw new Error('RESEARCH_DB_USER must differ from DB_USER and ML_DB_USER');
  }
  if (password.length < 16) throw new Error('RESEARCH_DB_PASS must be at least 16 characters');

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

  // Check the login: reads the history and the granted run columns, nothing else
  const research = new Client({ ...connection, user, password });
  await research.connect();
  try {
    for (const sql of ALLOWED_READS) {
      const { rows } = await research.query(sql);
      console.log(`allowed: ${sql} -> ${JSON.stringify(rows[0])}`);
    }
    const { rows: bars } = await research.query(ALLOWED_READS[0]);
    if (!(bars[0].n > 0)) throw new Error('the login reads no EUR/USD H1 bars');
    for (const sql of DENIED) {
      try {
        await research.query(sql);
        throw new Error(`the login was allowed: ${sql}`);
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code !== '42501') throw err; // insufficient_privilege
        console.log(`denied as expected: ${sql}`);
      }
    }
  } finally {
    await research.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
