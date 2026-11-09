// replay-service and trading-sim write only replay_*: never the imported history
// (historical_*), the live ticks or the live candles (candles_*), and never through the
// live feed's write path (insertLiveTick). The database enforces it too: the
// forexedge_replay login has no write grant on any of them (tools/ops/create-replay-db-user.ts,
// session.db.spec.ts). The repository-wide history scan is market-service's
// historical-isolation.spec.ts, which covers these folders as well.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../..');
const SCANNED = ['apps/replay-service/src', 'libs/trading-sim/src'];

const WRITE = String.raw`\b(?:(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?|COPY|ALTER\s+(?:TABLE|MATERIALIZED\s+VIEW)|DROP\s+(?:TABLE|VIEW|MATERIALIZED\s+VIEW))\s+(?:IF\s+EXISTS\s+|ONLY\s+)?"?|CALL\s+refresh_continuous_aggregate\s*\(\s*')`;
// A write statement whose target is market data (within one statement)
export const MARKET_DATA_WRITE = new RegExp(`${WRITE}(?:historical_|ticks\\b|candles_)`, 'i');
// Any write statement and its target (to show the scan sees the writes that do exist)
const ANY_WRITE = new RegExp(`${WRITE}([a-z_]+)`, 'g'); // SQL keywords are upper case here

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|js)$/.test(name) && !/\.spec\.ts$/.test(name) ? [path] : [];
  });
}

const sources = () => SCANNED.flatMap((dir) => sourceFiles(join(REPO_ROOT, dir)))
  .map((f) => ({ file: relative(REPO_ROOT, f).replace(/\\/g, '/'), text: readFileSync(f, 'utf8').replace(/\s+/g, ' ') }));

describe('replay never writes market data', () => {
  it('recognises writes to the history, the live ticks and the live candles (and not reads or replay writes)', () => {
    for (const sql of [
      'INSERT INTO ticks (time) VALUES ($1)', 'insert into "ticks" select 1', 'UPDATE historical_candles SET x = 1',
      'DELETE FROM candles_1m', 'TRUNCATE candles_1h', 'COPY historical_candles FROM STDIN',
      `CALL refresh_continuous_aggregate('candles_5m', NULL, NULL)`, 'ALTER MATERIALIZED VIEW historical_candles_1h SET (x)',
    ]) {
      expect(sql).toMatch(MARKET_DATA_WRITE);
    }
    for (const sql of [
      'SELECT * FROM ticks', 'SELECT time FROM historical_candles WHERE pair = $1', 'FROM candles_1m',
      'UPDATE replay_sessions SET balance = balance + $2', 'INSERT INTO replay_positions (id) VALUES ($1)',
    ]) {
      expect(sql).not.toMatch(MARKET_DATA_WRITE);
    }
  });

  it('the scanned code writes replay_* and reads the history, and nothing else', () => {
    const files = sources();
    expect(files.length).toBeGreaterThan(30);
    expect(files.filter((f) => /historical_candles/.test(f.text)).length).toBeGreaterThan(0);
    const targets = new Set(files.flatMap((f) => [...f.text.matchAll(ANY_WRITE)].map((m) => m[1].toLowerCase())));
    expect([...targets]).toEqual(['replay_sessions']); // the relative balance/clock/status updates
    expect(files.filter((f) => MARKET_DATA_WRITE.test(f.text)).map((f) => f.file)).toEqual([]);
  });

  it('never uses the live feed write path', () => {
    expect(sources().filter((f) => /insertLiveTick|live-ticks/.test(f.text)).map((f) => f.file)).toEqual([]);
  });
});
