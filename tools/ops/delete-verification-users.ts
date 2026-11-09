// Deletes the throwaway users that the verification and end-to-end tools register,
// with everything they own: replay positions and sessions, backtest runs and their
// MinIO results. Only emails the tools generate match:
//   verify_<8 hex>@example.com        npm run backtest:verify
//   replayverify_<8 hex>@example.com  npm run replay:verify
//   replaye2e_<8 hex>@example.com     npm run replay:e2e
//   replaysmoke_<8 hex>@example.com   manual replay smoke checks (step 6b-1)
// Refuses if any of them has orders, positions or an account summary (they never
// trade), or a backtest still queued or running. Their BullMQ jobs are stale once the
// runs are gone: remove them afterwards with clear-stale-backtest-jobs.ts --apply.
//
// Dry run by default (lists what it would delete); --apply deletes, in one transaction
// after the results objects are removed. From the repo root:
//   npx ts-node --transpile-only tools/ops/delete-verification-users.ts [--apply]
import * as path from 'path';
import { Client as MinioClient } from 'minio';
import { Client } from 'pg';

const BUCKET = 'backtests';
const THROWAWAY_EMAIL = '^(verify|replayverify|replaye2e|replaysmoke)_[0-9a-f]{8}@example\\.com$';

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  process.loadEnvFile(path.resolve(__dirname, '../../.env'));
  const env = process.env;
  const db = new Client({
    host: env['DB_HOST'] || 'localhost', port: Number(env['DB_PORT']), user: env['DB_USER'],
    password: env['DB_PASS'], database: env['DB_NAME'],
  });
  const minio = new MinioClient({
    endPoint: env['MINIO_ENDPOINT'] ?? 'localhost', port: Number(env['MINIO_PORT'] ?? 9000),
    useSSL: env['MINIO_USE_SSL'] === 'true', accessKey: env['MINIO_USER'] ?? '', secretKey: env['MINIO_PASS'] ?? '',
  });
  await db.connect();
  try {
    const { rows: users } = await db.query(`
      SELECT u.id, u.email,
             (SELECT count(*)::int FROM orders o WHERE o.user_id = u.id) AS orders,
             (SELECT count(*)::int FROM positions p WHERE p.user_id = u.id) AS positions,
             (SELECT count(*)::int FROM account_summary a WHERE a.user_id = u.id) AS accounts,
             (SELECT count(*)::int FROM backtest_runs b WHERE b.user_id = u.id) AS runs,
             (SELECT count(*)::int FROM backtest_runs b WHERE b.user_id = u.id AND b.status IN ('QUEUED', 'RUNNING')) AS busy,
             (SELECT count(*)::int FROM replay_sessions s WHERE s.user_id = u.id) AS sessions,
             (SELECT count(*)::int FROM replay_positions rp JOIN replay_sessions s ON s.id = rp.session_id
               WHERE s.user_id = u.id) AS replay_positions
        FROM users u WHERE u.email ~ $1 ORDER BY u.created_at`, [THROWAWAY_EMAIL]);
    for (const u of users) {
      console.log(`${u.email}: ${u.runs} backtest run(s), ${u.sessions} replay session(s), ` +
        `${u.replay_positions} replay position(s)`);
    }
    console.log(`${users.length} throwaway user(s)`);
    const trading = users.filter((u) => u.orders + u.positions + u.accounts > 0);
    if (trading.length > 0) throw new Error(`refusing: ${trading.map((u) => u.email).join(', ')} own trading data`);
    const busy = users.filter((u) => u.busy > 0);
    if (busy.length > 0) throw new Error(`refusing: ${busy.map((u) => u.email).join(', ')} have a queued or running backtest`);
    if (!apply || users.length === 0) {
      if (!apply) console.log('dry run: nothing deleted (pass --apply)');
      return;
    }

    const ids = users.map((u) => u.id);
    const { rows: objects } = await db.query(
      'SELECT minio_object_key AS key FROM backtest_runs WHERE user_id = ANY($1) AND minio_object_key IS NOT NULL', [ids]);
    for (const { key } of objects) await minio.removeObject(BUCKET, key);
    console.log(`removed ${objects.length} results object(s)`);

    await db.query('BEGIN');
    const del = async (sql: string) => (await db.query(sql, [ids])).rowCount;
    const counts = {
      replayPositions: await del(`DELETE FROM replay_positions WHERE session_id IN (SELECT id FROM replay_sessions WHERE user_id = ANY($1))`),
      replaySessions: await del('DELETE FROM replay_sessions WHERE user_id = ANY($1)'),
      backtestRuns: await del('DELETE FROM backtest_runs WHERE user_id = ANY($1)'),
      users: await del('DELETE FROM users WHERE id = ANY($1)'),
    };
    await db.query('COMMIT');
    console.log(`deleted: ${JSON.stringify(counts)}`);
  } catch (err) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
