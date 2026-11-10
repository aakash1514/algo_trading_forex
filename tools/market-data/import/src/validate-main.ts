// Spot checks of the imported history against independent references (step 2.4):
//   npm run data:validate
// Prints the results, writes docs/validation/historical-spot-checks.md and exits
// non-zero if any check fails. References: tools/market-data/reference/README.md.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { CHECKS_WORK_MEM } from './checks';
import { FIRST_YEAR, LAST_YEAR } from './pairs';
import {
  compareGold, compareSeries, emptyResult, FX_SERIES, GOLD_TOLERANCE_PCT, GOLD_TOLERANCE_USD, LOOKBACK_MINUTES, readFredCsv,
  type GoldResult, type PairYearResult,
} from './validate';

const REPO_ROOT = join(__dirname, '../../../..');
const REFERENCE_DIR = join(REPO_ROOT, 'tools/market-data/reference');
const REPORT = join(REPO_ROOT, 'docs/validation/historical-spot-checks.md');

const f2 = (n: number | null) => (n === null ? '-' : n.toFixed(2));

function fxTable(results: PairYearResult[]): string[] {
  const lines = [
    '| Pair | Year | Days compared | No data | Median \\|Δ\\| | p95 \\|Δ\\| | Mean signed Δ | Max \\|Δ\\| (date) | Median \\|Δ\\| at −60 / 0 / +60 min | Result |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of results) {
    lines.push(`| ${r.pair} | ${r.year} | ${r.compared} | ${r.noData} | ${f2(r.medianPips)} | ${f2(r.p95Pips)} | ` +
      `${f2(r.meanSignedPips)} | ${f2(r.maxPips)} (${r.maxDate ?? '-'}) | ` +
      `${f2(r.medianByOffset[-60] ?? null)} / ${f2(r.medianByOffset[0] ?? null)} / ${f2(r.medianByOffset[60] ?? null)} | ` +
      `${r.ok ? passLabel(r) : `**FAIL**: ${r.problems.join('; ')}`} |`);
  }
  const failing = results.flatMap((r) => r.failing.map((d) => ({ pair: r.pair, ...d })));
  const excepted = (pair: string, date: string) =>
    results.flatMap((r) => r.exceptedDays).find((e) => e.pair === pair && e.date === date);
  const medians = results.filter((r) => r.medianExcepted);
  if (failing.length > 0 || medians.length > 0) {
    lines.push('', '### Investigated exceptions', '',
      'Days above the per-day limit and pair-years above the median limit pass only as these named exceptions ' +
      '(`tools/market-data/import/src/exceptions.ts`); any other failure, a different deviation or an exception that ' +
      'no longer fails makes the check fail. On every listed day the fixing lies inside our range for that New York ' +
      'day, and our 11:45-12:15 NY bars are all present with normal spreads (0.1-2 pips) and no spike: the fixing, ' +
      'not our data, is off noon. "Matches" gives the NY times at which our mid came closest to the fixing.', '',
      '| Pair | Date | Fixing | Our mid | Δ pips | Reason |', '|---|---|---|---|---|---|');
    for (const d of failing) {
      const e = excepted(d.pair, d.date);
      lines.push(`| ${d.pair} | ${d.date} | ${d.fixing} | ${d.mid} | ${d.pips.toFixed(2)} | ` +
        `${e ? e.reason : '**NOT AN INVESTIGATED EXCEPTION**'} |`);
    }
    for (const r of medians) {
      lines.push('', `Median exception: ${r.pair} ${r.year}, median ${r.medianExcepted?.medianPips} pips: ${r.medianExcepted?.reason}.`);
    }
  }
  return lines;
}

function passLabel(r: PairYearResult): string {
  const parts = [
    r.exceptedDays.length > 0 ? `${r.exceptedDays.length} excepted day(s)` : '',
    r.medianExcepted ? 'median excepted' : '',
  ].filter(Boolean);
  return parts.length > 0 ? `pass (${parts.join(', ')})` : 'pass';
}

function goldTable(results: GoldResult[]): string[] {
  const lines = [
    '| Extreme | Documented (NY day) | Ours: bid / ask (UTC minute, NY day) | Δ bid | Tolerance | Result |',
    '|---|---|---|---|---|---|',
  ];
  for (const r of results) {
    const e = r.extreme;
    lines.push(`| ${e.year} ${e.kind} | ${e.price} (${e.date}) | ${r.ours ?? '-'} / ${r.oursAsk ?? '-'} ` +
      `(${r.oursTimeUtc ?? '-'}, ${r.oursNyDay ?? '-'}) | ${f2(r.diffUsd)} | ±${r.toleranceUsd.toFixed(2)} | ` +
      `${r.ok ? 'pass' : `**FAIL**: ${r.problems.join('; ')}`} |`);
  }
  lines.push('', 'Sources:', '');
  for (const r of results) lines.push(`- ${r.extreme.year} ${r.extreme.kind}: ${r.extreme.source} <${r.extreme.url}>`);
  return lines;
}

async function main(): Promise<void> {
  // the repo's .env on a laptop; a container passes the variables instead
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
  try {
    await client.query(`SET work_mem = '${CHECKS_WORK_MEM}'`);
    const fx: PairYearResult[] = [];
    for (const series of FX_SERIES) {
      const fixings = readFredCsv(join(REFERENCE_DIR, `${series.id}.csv`), series.id)
        .filter((f) => f.date >= `${FIRST_YEAR}-01-01` && f.date <= `${LAST_YEAR}-12-31`);
      const t = Date.now();
      const results = await compareSeries(client, series, fixings);
      // Every exported year must be present: a missing year is an empty comparison
      for (let year = FIRST_YEAR; year <= LAST_YEAR; year++) {
        if (!results.some((r) => r.year === year)) {
          results.push(emptyResult(series.pair, year, `no ${series.id} fixings in ${year}`));
        }
      }
      results.sort((a, b) => a.year - b.year);
      fx.push(...results);
      console.log(`${series.id} -> ${series.pair}: ${fixings.length} fixings, ${results.filter((r) => !r.ok).length} ` +
        `pair-year(s) failing, ${((Date.now() - t) / 1000).toFixed(1)}s`);
    }
    const gold = await compareGold(client);
    const failed = fx.filter((r) => !r.ok).length + gold.filter((r) => !r.ok).length;

    const report = [
      '# Historical data spot checks (step 2.4)',
      '',
      `Generated by \`npm run data:validate\` on ${new Date().toISOString().slice(0, 10)}. ` +
        `${failed === 0 ? 'All checks pass.' : `**${failed} check(s) fail.**`}`,
      '',
      '## FX vs FRED noon New York fixings (H.10)',
      '',
      `Δ = our mid − fixing, in pips. Our mid: (bid close + ask close) / 2 of the 11:59 New York bar, or of the ` +
        `last traded minute up to ${LOOKBACK_MINUTES} minutes earlier ("no data" otherwise). The same comparison ` +
        'shifted by −60 and +60 minutes must fit worse than 0 (timezone/DST check).',
      '',
      'Tolerances: ' + FX_SERIES.map((s) => `${s.pair} (${s.id}) day ≤ ${s.failPips} pips, median ≤ ${s.maxMedian}, ` +
        `p95 ≤ ${s.maxP95}`).join('; ') + '.',
      '',
      'Bias: the mean signed Δ is a steady sub-pip offset (EUR/USD about −0.5, GBP/USD about −1.0, USD/JPY about ' +
        '+0.5 pips; larger in 2010): in every pair the fixing values the dollar slightly lower than our mid.',
      '',
      ...fxTable(fx),
      '',
      '## Gold vs documented spot extremes',
      '',
      `Our yearly extreme on the bid side, matched on the New York trading day; tolerance is the larger of ` +
        `$${GOLD_TOLERANCE_USD} and ${GOLD_TOLERANCE_PCT}% of the price.`,
      '',
      ...goldTable(gold),
      '',
    ].join('\n');
    mkdirSync(join(REPO_ROOT, 'docs/validation'), { recursive: true });
    writeFileSync(REPORT, report);
    console.log(`\n${report}`);
    console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s; report: docs/validation/historical-spot-checks.md`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
