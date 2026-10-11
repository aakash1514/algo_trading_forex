// Backs up and deletes the backtest runs made before roadmap step 3, whose
// results are in pips only (no initial capital, no USD P&L; their drawdown and
// Sharpe were computed on pips). Run once, BEFORE the BacktestRunMoney migration,
// which refuses to run while such rows exist. Afterwards, run
// clear-stale-backtest-jobs.ts --apply to drop their BullMQ jobs.
//
//   1. Backup to data/backups/backtest-runs/<timestamp>/ (gitignored): every row
//      as JSON, each run's MinIO results.json, and a manifest with sha256s. Each
//      file is read back and its hash re-checked before anything is deleted.
//   2. Delete the rows in one transaction (re-checking the exact ids), then the
//      MinIO objects.
//
// Dry run by default (lists the runs); --apply backs up and deletes. From the repo root:
//   npx ts-node --transpile-only tools/ops/purge-pip-backtest-runs.ts [--apply]
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { Client as MinioClient } from 'minio';
import { Client } from 'pg';

const BUCKET = 'backtests';
const REPO_ROOT = path.resolve(__dirname, '../..');

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

async function readObject(minio: MinioClient, key: string): Promise<Buffer> {
  const stream = await minio.getObject(BUCKET, key);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

// Write, then read back and compare the hash
function writeVerified(file: string, data: Buffer | string): string {
  writeFileSync(file, data);
  const hash = sha256(data);
  if (sha256(readFileSync(file)) !== hash) throw new Error(`backup ${file} does not read back identically`);
  return hash;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  process.loadEnvFile(path.join(REPO_ROOT, '.env'));
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
    const { rows: columns } = await db.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'backtest_runs' AND column_name = 'initial_capital'`);
    if (columns.length > 0) throw new Error('backtest_runs already has initial_capital: the money migration has run, nothing to purge');

    const { rows: runs } = await db.query(`SELECT * FROM backtest_runs ORDER BY created_at`);
    console.log(`${runs.length} pip-only run(s):`);
    for (const r of runs) {
      console.log(`  ${r.id}  ${r.strategy_name} ${r.instrument} ${r.timeframe} ${r.status} ` +
        `trades=${r.total_trades ?? '-'} pnl=${r.total_pnl ?? '-'} pips  results=${r.minio_object_key ?? '-'}`);
    }
    if (runs.length === 0) return;
    if (!apply) {
      console.log('dry run; pass --apply to back up and delete');
      return;
    }
    if (runs.some((r) => r.status === 'RUNNING' || r.status === 'QUEUED')) {
      throw new Error('a run is QUEUED or RUNNING; stop ws-gateway and let it finish first');
    }

    // 1. Backup
    const dir = path.join(REPO_ROOT, 'data/backups/backtest-runs', new Date().toISOString().replace(/[:.]/g, '-'));
    mkdirSync(dir, { recursive: true });
    const manifest: { file: string; sha256: string; bytes: number }[] = [];
    const rowsJson = JSON.stringify(runs, null, 2);
    manifest.push({ file: 'backtest_runs.json', sha256: writeVerified(path.join(dir, 'backtest_runs.json'), rowsJson), bytes: Buffer.byteLength(rowsJson) });
    for (const r of runs.filter((x) => x.minio_object_key)) {
      const data = await readObject(minio, r.minio_object_key);
      JSON.parse(data.toString('utf8')); // a results file that isn't JSON stops the purge
      const file = `${r.id}.results.json`;
      manifest.push({ file, sha256: writeVerified(path.join(dir, file), data), bytes: data.length });
    }
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ createdAt: new Date().toISOString(), runs: runs.length, files: manifest }, null, 2));
    console.log(`backed up ${runs.length} row(s) and ${manifest.length - 1} results file(s) to ${path.relative(REPO_ROOT, dir)}`);

    // 2. Delete exactly the backed-up rows, then their result objects
    const ids = runs.map((r) => r.id);
    await db.query('BEGIN');
    const { rowCount } = await db.query('DELETE FROM backtest_runs WHERE id = ANY($1::uuid[])', [ids]);
    if (rowCount !== ids.length) {
      await db.query('ROLLBACK');
      throw new Error(`expected to delete ${ids.length} rows, matched ${rowCount}; rolled back`);
    }
    await db.query('COMMIT');
    for (const r of runs.filter((x) => x.minio_object_key)) await minio.removeObject(BUCKET, r.minio_object_key);
    const { rows: left } = await db.query('SELECT count(*)::int AS n FROM backtest_runs');
    console.log(`deleted ${rowCount} row(s) and their results objects; backtest_runs now has ${left[0].n} row(s)`);
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
