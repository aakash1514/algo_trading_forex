// Creates (or re-passwords) the ML service's database login, a member of the
// read-only group role forexedge_readonly (migration ReadOnlyRole). The name and
// password come from .env (ML_DB_USER, ML_DB_PASS); the password is never printed.
// Then it connects as that login and checks it can read historical_candles_1h and
// cannot read users or write anything.
//
// From the repo root, after npm run migration:run:
//   npx ts-node --transpile-only tools/ops/create-ml-db-user.ts
import * as path from 'path';
import { Client } from 'pg';

const GROUP_ROLE = 'forexedge_readonly';

async function main(): Promise<void> {
  process.loadEnvFile(path.resolve(__dirname, '../../.env'));
  const env = process.env;
  const user = env['ML_DB_USER'];
  const password = env['ML_DB_PASS'];
  if (!user || !password) throw new Error('set ML_DB_USER and ML_DB_PASS in .env');
  if (user === env['DB_USER']) throw new Error('ML_DB_USER must differ from DB_USER');
  if (password.length < 16) throw new Error('ML_DB_PASS must be at least 16 characters');

  const connection = { host: env['DB_HOST'] || 'localhost', port: Number(env['DB_PORT']), database: env['DB_NAME'] };
  const admin = new Client({ ...connection, user: env['DB_USER'], password: env['DB_PASS'] });
  await admin.connect();
  try {
    const { rows: group } = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [GROUP_ROLE]);
    if (group.length === 0) throw new Error(`role ${GROUP_ROLE} is missing: run npm run migration:run first`);
    const { rows: existing } = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [user]);
    const id = admin.escapeIdentifier(user);
    const secret = admin.escapeLiteral(password);
    if (existing.length === 0) {
      await admin.query(`CREATE ROLE ${id} LOGIN PASSWORD ${secret} IN ROLE ${GROUP_ROLE}`);
      console.log(`created login ${user} in ${GROUP_ROLE}`);
    } else {
      await admin.query(`ALTER ROLE ${id} LOGIN PASSWORD ${secret}`);
      await admin.query(`GRANT ${GROUP_ROLE} TO ${id}`);
      console.log(`updated login ${user} (password reset, member of ${GROUP_ROLE})`);
    }
  } finally {
    await admin.end();
  }

  // Check the login: reads the history, nothing else
  const ml = new Client({ ...connection, user, password });
  await ml.connect();
  try {
    const { rows } = await ml.query(`SELECT count(*)::int AS n FROM historical_candles_1h WHERE pair = 'EUR/USD'`);
    if (!(rows[0].n > 0)) throw new Error('the login reads no EUR/USD H1 bars');
    console.log(`read check: ${rows[0].n} EUR/USD H1 bars`);
    for (const sql of ['SELECT 1 FROM users LIMIT 1', `DELETE FROM historical_candles WHERE false`]) {
      try {
        await ml.query(sql);
        throw new Error(`the login was allowed: ${sql}`);
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code !== '42501') throw err; // insufficient_privilege
        console.log(`denied as expected: ${sql}`);
      }
    }
  } finally {
    await ml.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
