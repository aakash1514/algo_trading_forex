// The history transfer (transfer.ts) from the command line. Connects as DB_USER (the history tables'
// owner); reads the repo's .env on a laptop, the environment in a container.
//
//   npm run data:transfer -- export [--dir data/history-transfer]   on the source (dev) database
//   npm run data:transfer -- import [--dir data/history-transfer]   on an empty production database
//   npm run data:transfer -- check  [--dir data/history-transfer]   any time: fails unless identical
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import { compareWithManifest, exportHistory, importHistory, readManifest } from './transfer';

const REPO_ROOT = join(__dirname, '../../../..');
const DEFAULT_DIR = join(REPO_ROOT, 'data/history-transfer');

function parse(argv: string[]): { command: 'export' | 'import' | 'check'; dir: string } {
  const [command, ...rest] = argv;
  if (command !== 'export' && command !== 'import' && command !== 'check') {
    throw new Error('usage: data:transfer -- export|import|check [--dir <directory>]');
  }
  let dir = DEFAULT_DIR;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--dir' && rest[i + 1]) dir = resolve(rest[++i]);
    else throw new Error(`unknown argument ${rest[i]}`);
  }
  return { command, dir };
}

async function main(): Promise<void> {
  const { command, dir } = parse(process.argv.slice(2));
  const envFile = join(REPO_ROOT, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const env = process.env;
  const client = new Client({
    host: env['DB_HOST'] || 'localhost', port: Number(env['DB_PORT']), user: env['DB_USER'],
    password: env['DB_PASS'], database: env['DB_NAME'],
    ssl: env['DB_SSL'] === 'true' ? { rejectUnauthorized: true } : undefined,
  });
  await client.connect();
  const started = Date.now();
  const log = (line: string) => console.log(`[${((Date.now() - started) / 1000).toFixed(0).padStart(5)} s] ${line}`);
  try {
    await client.query('SET statement_timeout = 0');
    if (command === 'export') {
      const manifest = await exportHistory(client, dir, log);
      const rows = manifest.candles.reduce((n, p) => n + Number(p.rows), 0);
      log(`exported ${manifest.candles.length} pairs, ${rows} minutes, ${manifest.importLogRows} import-log rows to ${dir}`);
      return;
    }
    const problems = command === 'import'
      ? (await importHistory(client, dir, log)).problems
      : await compareWithManifest(client, readManifest(dir));
    const rows = readManifest(dir).candles.reduce((n, p) => n + Number(p.rows), 0);
    if (problems.length > 0) {
      console.error(`${command}: the database differs from ${dir}/manifest.json:\n  ${problems.join('\n  ')}`);
      process.exitCode = 1;
      return;
    }
    log(`${command}: identical to the export (${rows} minutes); next: npm run data:import -- --check-only, npm run data:validate`);
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
