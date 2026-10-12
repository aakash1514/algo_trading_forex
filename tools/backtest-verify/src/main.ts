// Independent verification of MA crossover backtests (roadmap step 3).
//
// For each pair: submit the backtest through the real API (auth-service and
// ws-gateway must be running), wait for it, fetch its results JSON, reproduce it
// with ma-crossover.sql from the raw M1 table, and compare trade by trade
// (compare.ts). Imports nothing from apps/ or libs/: the reproduction states the
// rules itself. Writes docs/validation/backtest-verification.md and exits 1 on
// any difference or empty input.
//
//   npm run backtest:verify -- [--pairs EUR_USD,XAU_USD] [--from 2022-01-01] [--to 2022-12-30]
//                              [--fast 10] [--slow 30] [--lots 0.1] [--capital 10000]
//                              [--report docs/validation/backtest-verification.md]
//
// It logs in with VERIFY_EMAIL / VERIFY_PASSWORD from the environment, or
// registers a fresh verification user when they are not set.
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import { compareRuns, Comparison, EngineResults, SqlResults } from './compare';

const REPO_ROOT = resolve(__dirname, '../../..');
const REPORT = join(REPO_ROOT, 'docs/validation/backtest-verification.md');
// 0.7 pip per side, round trip, at 10 points per pip
const COMMISSION_POINTS = 14;
const DAY_MS = 86_400_000;

interface Options {
  pairs: string[];
  from: string;
  to: string;
  fast: number;
  slow: number;
  lots: number;
  capital: number;
  report: string;
}

function parseOptions(argv: string[]): Options {
  const get = (flag: string, fallback: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  return {
    pairs: get('--pairs', 'EUR_USD,XAU_USD').split(','),
    from: get('--from', '2022-01-01'),
    to: get('--to', '2022-12-30'),
    fast: Number(get('--fast', '10')),
    slow: Number(get('--slow', '30')),
    lots: Number(get('--lots', '0.1')),
    capital: Number(get('--capital', '10000')),
    report: resolve(REPO_ROOT, get('--report', REPORT)),
  };
}

async function json<T>(res: Response, what: string): Promise<T> {
  const body = await res.text();
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status} ${body}`);
  return JSON.parse(body) as T;
}

async function accessToken(authUrl: string): Promise<{ token: string; user: string }> {
  const email = process.env['VERIFY_EMAIL'];
  const password = process.env['VERIFY_PASSWORD'];
  if (email && password) {
    const r = await json<{ accessToken: string }>(await fetch(`${authUrl}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
    }), 'login');
    return { token: r.accessToken, user: email };
  }
  const id = randomBytes(4).toString('hex');
  const fresh = { email: `verify_${id}@example.com`, username: `verify_${id}`, password: `Verify@${randomBytes(6).toString('hex')}1A`,
    firstName: 'Backtest', lastName: 'Verify' };
  const r = await json<{ accessToken: string }>(await fetch(`${authUrl}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fresh),
  }), 'register');
  return { token: r.accessToken, user: fresh.email };
}

async function runBacktest(apiUrl: string, token: string, pair: string, o: Options): Promise<{ runId: string; results: EngineResults }> {
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  const { runId } = await json<{ runId: string }>(await fetch(`${apiUrl}/backtest/run`, {
    method: 'POST', headers, body: JSON.stringify({
      strategyName: 'ma_crossover', instrument: pair, timeframe: '1h', fromDate: o.from, toDate: o.to,
      parameters: { fastPeriod: o.fast, slowPeriod: o.slow }, lots: o.lots, initialCapital: o.capital,
    }),
  }), 'submit');
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    const run = await json<{ status: string; errorMessage: string | null }>(await fetch(`${apiUrl}/backtest/${runId}`, { headers }), 'status');
    if (run.status === 'COMPLETED') break;
    if (run.status === 'FAILED' || run.status === 'CANCELLED') throw new Error(`run ${runId} ${run.status}: ${run.errorMessage}`);
    if (Date.now() > deadline) throw new Error(`run ${runId} still ${run.status} after 10 minutes`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  // The API redirects to a presigned results URL
  const results = await json<EngineResults>(await fetch(`${apiUrl}/backtest/${runId}/results`, { headers }), 'results');
  return { runId, results };
}

async function reproduce(db: Client, pair: string, o: Options): Promise<SqlResults> {
  const sql = readFileSync(join(__dirname, 'ma-crossover.sql'), 'utf8');
  const from = new Date(`${o.from}T00:00:00Z`);
  const end = new Date(new Date(`${o.to}T00:00:00Z`).getTime() + DAY_MS);
  const { rows } = await db.query(sql, [pair.replace('_', '/'), from, end, o.fast, o.slow, o.lots, o.capital, COMMISSION_POINTS]);
  return rows[0].result as SqlResults;
}

interface RunReport {
  pair: string;
  runId: string;
  engine: EngineResults;
  sql: SqlResults;
  comparison: Comparison;
}

const usd = (cents: number) => (cents / 100).toFixed(2);

function report(o: Options, runs: RunReport[], user: string, commit: string): string {
  const lines: string[] = [];
  lines.push('# Backtest verification (step 3)', '');
  lines.push(`Generated by \`npm run backtest:verify\` on ${new Date().toISOString()} at commit \`${commit}\`.`);
  lines.push(`Runs submitted through the real API as \`${user}\`; MA crossover ${o.fast}/${o.slow}, H1, ` +
    `${o.from} to ${o.to} (inclusive, UTC), ${o.lots} lot, initial capital $${o.capital}.`, '');
  lines.push('Each run is reproduced by `tools/backtest-verify/src/ma-crossover.sql` from the raw M1 table',
    '(H1 rebuilt with plain SQL, exact numeric SMAs, fills, money, equity, drawdown and Sharpe), without the',
    'backtester\'s code or the continuous aggregates, and compared field by field: times, prices in integer',
    'points, pips, gross/commission/net USD in cents, and the metrics at their stored scale.', '');
  lines.push('| Pair | Run | Bars | Trades (backtester / SQL) | Net USD | Final equity | Max DD % | Sharpe | Win rate | Profit factor | Result |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of runs) {
    const m = r.engine.metrics;
    lines.push(`| ${r.pair.replace('_', '/')} | \`${r.runId}\` | ${r.sql.bars} | ${r.engine.trades.length} / ${r.sql.trades.length} | ` +
      `${m.totalPnlUsd} / ${usd(Number(r.sql.metrics.netCents))} | ${r.engine.finalEquity.toFixed(2)} / ${usd(Number(r.sql.metrics.finalEquityCents))} | ` +
      `${m.maxDrawdownPct} / ${r.sql.metrics.maxDrawdownPct} | ${m.sharpeRatio} / ${r.sql.metrics.sharpe} | ` +
      `${m.winRate} / ${r.sql.metrics.winRate} | ${m.profitFactor} / ${r.sql.metrics.profitFactor} | ` +
      `${r.comparison.ok ? `**match** (${r.comparison.tradesCompared} trades)` : '**DIFFERS**'} |`);
  }
  lines.push('', 'Values are backtester / SQL.', '');
  for (const r of runs) {
    lines.push(`## ${r.pair.replace('_', '/')}`, '');
    if (r.comparison.errors.length) lines.push(...r.comparison.errors.map((e) => `- **Error:** ${e}`), '');
    if (r.comparison.mismatches.length) {
      lines.push('| Where | Field | Backtester | SQL |', '|---|---|---|---|');
      lines.push(...r.comparison.mismatches.map((m) => `| ${m.where} | ${m.field} | ${m.engine} | ${m.sql} |`), '');
    } else if (r.comparison.ok) {
      lines.push(`All ${r.comparison.tradesCompared} trades and every metric match exactly.`, '');
    }
    lines.push('<details><summary>Every trade (SQL reproduction)</summary>', '');
    lines.push('| # | Side | Entry (UTC) | Entry pts | Exit (UTC) | Exit pts | Exit | Pips | Net pips | Gross USD | Comm. USD | Net USD |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
    r.sql.trades.forEach((t, i) => lines.push(`| ${i + 1} | ${t.action} | ${new Date(t.entryTime).toISOString().slice(0, 16)} | ${t.entryPoints} | ` +
      `${new Date(t.exitTime).toISOString().slice(0, 16)} | ${t.exitPoints} | ${t.exitReason} | ${Number(t.pips).toFixed(1)} | ` +
      `${Number(t.netPips).toFixed(1)} | ${usd(Number(t.grossCents))} | ${usd(Number(t.commissionCents))} | ${usd(Number(t.netCents))} |`));
    lines.push('', '</details>', '');
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  process.loadEnvFile(join(REPO_ROOT, '.env'));
  const o = parseOptions(process.argv.slice(2));
  const authUrl = process.env['VERIFY_AUTH_URL'] ?? 'http://localhost:3000/api';
  const apiUrl = process.env['VERIFY_API_URL'] ?? 'http://localhost:3005/api';
  const env = process.env;
  const db = new Client({
    host: env['DB_HOST'] || 'localhost', port: Number(env['DB_PORT']), user: env['DB_USER'],
    password: env['DB_PASS'], database: env['DB_NAME'],
  });
  await db.connect();
  const runs: RunReport[] = [];
  try {
    const { token, user } = await accessToken(authUrl);
    for (const pair of o.pairs) {
      const { runId, results } = await runBacktest(apiUrl, token, pair, o);
      const sql = await reproduce(db, pair, o);
      const comparison = compareRuns(results, sql);
      runs.push({ pair, runId, engine: results, sql, comparison });
      console.log(`${pair}: run ${runId}, ${results.trades.length} trades / SQL ${sql.trades.length}: ` +
        `${comparison.ok ? 'MATCH' : `DIFFERS (${comparison.errors.length} errors, ${comparison.mismatches.length} mismatches)`}`);
      for (const e of comparison.errors) console.log(`  error: ${e}`);
      for (const m of comparison.mismatches.slice(0, 20)) console.log(`  ${m.where} ${m.field}: backtester ${m.engine}, SQL ${m.sql}`);
    }
    const commit = execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT }).toString().trim();
    writeFileSync(o.report, report(o, runs, user, commit));
    console.log(`report: ${o.report}`);
  } finally {
    await db.end();
  }
  if (runs.length === 0 || runs.some((r) => !r.comparison.ok)) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
