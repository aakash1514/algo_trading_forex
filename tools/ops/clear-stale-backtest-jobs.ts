// Removes stale BullMQ backtest jobs: jobs in Redis whose run no longer exists in
// backtest_runs (e.g. the mock-data runs deleted in roadmap step 2.0). Jobs of
// existing runs are kept. Refuses while any job is active (a worker is running one).
//
// Dry run by default (lists what it would remove); --apply removes. From the repo root:
//   npx ts-node --transpile-only tools/ops/clear-stale-backtest-jobs.ts [--apply]
import * as path from 'path';
import { Queue } from 'bullmq';
import { Client } from 'pg';

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  process.loadEnvFile(path.resolve(__dirname, '../../.env'));
  const env = process.env;

  const queue = new Queue('backtest', {
    connection: {
      host: env['REDIS_HOST'] ?? 'localhost',
      port: Number(env['REDIS_PORT'] ?? 6379),
      password: env['REDIS_PASS'] || undefined,
      username: env['REDIS_USERNAME'] ?? 'default',
      tls: env['REDIS_TLS'] === 'true' ? {} : undefined,
    },
  });
  const db = new Client({
    host: env['DB_HOST'] || 'localhost', port: Number(env['DB_PORT']), user: env['DB_USER'],
    password: env['DB_PASS'], database: env['DB_NAME'],
  });
  await db.connect();
  try {
    const counts = await queue.getJobCounts();
    console.log('job counts:', JSON.stringify(counts));
    if (counts['active'] > 0) throw new Error(`${counts['active']} job(s) active; stop ws-gateway's worker first`);

    const jobs = await queue.getJobs(['completed', 'failed', 'waiting', 'delayed', 'paused', 'prioritized']);
    const ids = jobs.map((j) => j.data?.runId ?? j.id).filter(Boolean);
    const { rows } = await db.query('SELECT id::text FROM backtest_runs WHERE id::text = ANY($1)', [ids]);
    const existing = new Set(rows.map((r) => r.id));
    const stale = jobs.filter((j) => !existing.has(j.data?.runId ?? j.id));

    console.log(`${jobs.length} job(s); ${stale.length} stale (no backtest_runs row)`);
    for (const job of stale) {
      console.log(`  ${apply ? 'removing' : 'would remove'} ${job.id} (${await job.getState()}, ` +
        `${job.data?.instrument ?? '?'} ${job.data?.fromDate ?? ''}..${job.data?.toDate ?? ''})`);
      if (apply) await job.remove();
    }
    if (!apply && stale.length > 0) console.log('dry run; pass --apply to remove');
    if (apply) console.log('after:', JSON.stringify(await queue.getJobCounts()));
  } finally {
    await queue.close();
    await db.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
