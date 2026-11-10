// Prepares a fresh production database, in order, and is safe to run again (every step is idempotent):
//
//   1. migrations          npm run migration:run (tables, hypertables, aggregates, the group roles)
//   2. instruments         npm run seed:instruments (ON CONFLICT DO NOTHING; existing rows untouched)
//   3. history loaded?     stops here until the history is in (npm run data:transfer -- import, which
//                          needs step 1): each login tool proves its grants by reading EUR/USD H1 bars,
//                          and an empty read proves nothing
//   4. ML login            tools/ops/create-ml-db-user.ts        (ML_DB_USER / ML_DB_PASS)
//   5. research login      tools/ops/create-research-db-user.ts  (RESEARCH_DB_USER / RESEARCH_DB_PASS)
//   6. replay login        tools/ops/create-replay-db-user.ts    (REPLAY_DB_USER / REPLAY_DB_PASS)
//   7. demo users          tools/ops/create-demo-users.ts        (DEMO_USERS; skipped when unset)
//
// So on a fresh database: bootstrap (stops at 3) -> data:transfer import -> bootstrap again (all steps).
// Each step runs as its own process and the first failure stops the rest.
// In production: docker compose -f infra/docker-compose.prod.yml --env-file infra/.env.prod run --rm ops \
//                  npx ts-node --transpile-only tools/ops/bootstrap-prod.ts
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const TS_NODE = ['ts-node', '--transpile-only'];

export interface Step {
  name: string;
  command: string[];
  skip?: (env: NodeJS.ProcessEnv) => string | null; // a reason to skip, or null
}

export const STEPS: Step[] = [
  { name: 'migrations', command: ['typeorm-ts-node-commonjs', '-d', 'data-source.ts', 'migration:run'] },
  { name: 'instruments', command: ['ts-node', '-r', 'tsconfig-paths/register', 'apps/auth-service/src/seeds/run-seeds.ts'] },
  { name: 'history loaded', command: [...TS_NODE, 'tools/ops/check-history-loaded.ts'] },
  { name: 'ML login', command: [...TS_NODE, 'tools/ops/create-ml-db-user.ts'] },
  { name: 'research login', command: [...TS_NODE, 'tools/ops/create-research-db-user.ts'] },
  { name: 'replay login', command: [...TS_NODE, 'tools/ops/create-replay-db-user.ts'] },
  {
    name: 'demo users',
    command: [...TS_NODE, 'tools/ops/create-demo-users.ts'],
    skip: (env) => (env['DEMO_USERS']?.trim() ? null : 'DEMO_USERS is not set'),
  },
];

function main(): void {
  const envFile = path.join(REPO_ROOT, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  for (const step of STEPS) {
    const skipped = step.skip?.(process.env);
    if (skipped) {
      console.log(`[bootstrap] ${step.name}: skipped (${skipped})`);
      continue;
    }
    console.log(`[bootstrap] ${step.name} ...`);
    const started = Date.now();
    const result = spawnSync(npx, step.command, { cwd: REPO_ROOT, stdio: 'inherit', env: process.env, shell: process.platform === 'win32' });
    if (result.status !== 0) {
      console.error(`[bootstrap] ${step.name} failed (exit ${result.status ?? result.signal}); stopped`);
      process.exit(1);
    }
    console.log(`[bootstrap] ${step.name}: ok (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  }
  console.log('[bootstrap] done');
}

if (require.main === module) main();
