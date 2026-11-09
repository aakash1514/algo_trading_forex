import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// No feed code can write the imported history. The historical_* tables are written only by
// tools/market-data/import (and created by the migrations); every service and shared library may read
// them but never INSERT/UPDATE/DELETE/TRUNCATE/COPY/ALTER/DROP them. A database-level guard (a
// market-service login with INSERT on ticks only) is planned for deployment (roadmap step 7); the
// DB-level behaviour is tested in tools/market-data/import/src/live-isolation.db.spec.ts.

const REPO_ROOT = join(__dirname, '../../../..');
const SCANNED = [
  'apps/market-service/src', 'apps/order-service/src', 'apps/domain-service/src', 'apps/ws-gateway/src',
  'apps/replay-service/src', 'libs/common/src', 'libs/database/src', 'libs/kafka/src', 'libs/trading-sim/src',
];

// A write statement whose target is a historical_* relation (within one statement).
export const HISTORICAL_WRITE =
  /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?|COPY|ALTER\s+TABLE|DROP\s+(?:TABLE|VIEW|MATERIALIZED\s+VIEW))\s+(?:IF\s+EXISTS\s+|ONLY\s+)?"?historical_/i;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|js)$/.test(name) && !/\.spec\.ts$/.test(name) ? [path] : [];
  });
}

describe('historical tables are read-only for every feed and service', () => {
  it('recognises a write to a historical relation (and not a read)', () => {
    for (const sql of [
      'INSERT INTO historical_candles (time) VALUES ($1)', 'update historical_coverage set x = 1',
      'DELETE FROM historical_import_log', 'TRUNCATE historical_candles', 'COPY historical_candles FROM STDIN',
      'ALTER TABLE historical_candles SET (timescaledb.compress)', 'DROP MATERIALIZED VIEW IF EXISTS historical_candles_1h',
    ]) {
      expect(sql).toMatch(HISTORICAL_WRITE);
    }
    for (const sql of ['SELECT * FROM historical_candles', 'INSERT INTO ticks (time) VALUES ($1)', 'FROM historical_coverage']) {
      expect(sql).not.toMatch(HISTORICAL_WRITE);
    }
  });

  it('detects the one legitimate writer, the historical importer', () => {
    const importer = readFileSync(join(REPO_ROOT, 'tools/market-data/import/src/importer.ts'), 'utf8');
    expect(importer.replace(/\s+/g, ' ')).toMatch(HISTORICAL_WRITE);
  });

  it('finds no such write in the services and shared libraries', () => {
    const files = SCANNED.flatMap((dir) => sourceFiles(join(REPO_ROOT, dir)));
    expect(files.length).toBeGreaterThan(100);
    const reading = files.filter((f) => /historical_/.test(readFileSync(f, 'utf8')));
    expect(reading.length).toBeGreaterThan(0); // the scan does see the code that reads the history
    const writers = files
      .filter((f) => HISTORICAL_WRITE.test(readFileSync(f, 'utf8').replace(/\s+/g, ' ')))
      .map((f) => relative(REPO_ROOT, f));
    expect(writers).toEqual([]);
  });
});
