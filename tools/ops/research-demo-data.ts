// Research agent demo data (roadmap step 5): two permanent dev users with real backtest
// runs, made through the real API and each one checked against the independent SQL
// reproduction (npm run backtest:verify). The research agent's backtest tools read
// these runs; keep the users and their runs (they are not throwaway).
//
//   research_demo    MA crossover 10/30 H1 2022, EUR/USD, XAU/USD, USD/JPY (the step-3 set)
//   research_demo_2  MA crossover 10/30 H1 2021, EUR/USD
//
// Passwords come from .env (RESEARCH_DEMO_PASS, RESEARCH_DEMO_2_PASS) and are never
// printed. A user is registered through auth-service (role TRADER, the default for
// registration; no endpoint is role-gated) or, if it exists, logged in. A user that
// already has completed runs is skipped, so re-running adds no duplicates.
//
// auth-service and ws-gateway (with MinIO) must be running. From the repo root:
//   npx ts-node --transpile-only tools/ops/research-demo-data.ts
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../..');
const AUTH_URL = process.env['VERIFY_AUTH_URL'] ?? 'http://localhost:3000/api';
const API_URL = process.env['VERIFY_API_URL'] ?? 'http://localhost:3005/api';

interface DemoUser {
  username: string;
  passwordEnv: string;
  verifyArgs: string[];
  report: string;
}

const USERS: DemoUser[] = [
  {
    username: 'research_demo',
    passwordEnv: 'RESEARCH_DEMO_PASS',
    verifyArgs: ['--pairs', 'EUR_USD,XAU_USD,USD_JPY', '--from', '2022-01-01', '--to', '2022-12-30'],
    report: 'docs/validation/research-demo-backtests.md',
  },
  {
    username: 'research_demo_2',
    passwordEnv: 'RESEARCH_DEMO_2_PASS',
    verifyArgs: ['--pairs', 'EUR_USD', '--from', '2021-01-01', '--to', '2021-12-31'],
    report: 'docs/validation/research-demo-2-backtests.md',
  },
];

async function post(url: string, body: object): Promise<Response> {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

async function loginOrRegister(user: DemoUser, email: string, password: string): Promise<string> {
  const login = await post(`${AUTH_URL}/auth/login`, { email, password });
  if (login.ok) return ((await login.json()) as { accessToken: string }).accessToken;
  if (login.status !== 401) throw new Error(`${user.username}: login HTTP ${login.status}`);
  const reg = await post(`${AUTH_URL}/auth/register`, {
    email, username: user.username, password, firstName: 'Research', lastName: 'Demo',
  });
  if (!reg.ok) throw new Error(`${user.username}: register HTTP ${reg.status} ${await reg.text()}`);
  console.log(`${user.username}: registered`);
  return ((await reg.json()) as { accessToken: string }).accessToken;
}

async function completedRuns(token: string): Promise<number> {
  const res = await fetch(`${API_URL}/backtest`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`list runs HTTP ${res.status}`);
  const runs = (await res.json()) as { status: string }[];
  return runs.filter((r) => r.status === 'COMPLETED').length;
}

async function main(): Promise<void> {
  process.loadEnvFile(join(REPO_ROOT, '.env'));
  for (const user of USERS) {
    const password = process.env[user.passwordEnv];
    if (!password) throw new Error(`set ${user.passwordEnv} in .env`);
    const email = `${user.username}@example.com`;
    const token = await loginOrRegister(user, email, password);
    const done = await completedRuns(token);
    if (done > 0) {
      console.log(`${user.username}: already has ${done} completed run(s); skipped`);
      continue;
    }
    console.log(`${user.username}: running ${user.verifyArgs.join(' ')}`);
    const r = spawnSync(
      process.execPath,
      [
        require.resolve('ts-node/dist/bin.js'), '--transpile-only', '--project', 'tools/backtest-verify/tsconfig.app.json',
        'tools/backtest-verify/src/main.ts', ...user.verifyArgs, '--report', user.report,
      ],
      { cwd: REPO_ROOT, stdio: 'inherit', env: { ...process.env, VERIFY_EMAIL: email, VERIFY_PASSWORD: password } },
    );
    if (r.status !== 0) throw new Error(`${user.username}: backtest:verify failed (exit ${r.status})`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
