// Bootstrap step: is the imported history in this database (the EUR/USD H1 bars the login tools read)?
// Exit 0 with the counts, or 1 telling the operator to run `npm run data:transfer -- import` first.
import { existsSync } from 'fs';
import * as path from 'path';
import { Client } from 'pg';

async function main(): Promise<void> {
  const envFile = path.resolve(__dirname, '../../.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const env = process.env;
  const db = new Client({
    host: env['DB_HOST'], port: Number(env['DB_PORT']), database: env['DB_NAME'], user: env['DB_USER'], password: env['DB_PASS'],
    ssl: env['DB_SSL'] === 'true' ? { rejectUnauthorized: false } : false,
  });
  await db.connect();
  try {
    const { rows } = await db.query(`SELECT (SELECT count(*) FROM historical_import_log)::int AS years,
      (SELECT count(*) FROM historical_candles_1h WHERE pair = 'EUR/USD')::int AS eurusd_h1`);
    const { years, eurusd_h1 } = rows[0];
    if (!(years > 0 && eurusd_h1 > 0)) {
      console.error('The history is not loaded (no import-log rows or EUR/USD H1 bars). Run ' +
        '`npm run data:transfer -- import`, then this bootstrap again.');
      process.exit(1);
    }
    console.log(`history: ${years} pair-years imported, ${eurusd_h1} EUR/USD H1 bars`);
  } finally {
    await db.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
