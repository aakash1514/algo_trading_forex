// Equivalence of replay and the verified backtester (roadmap step 6b-1).
//
// Takes the trades of a verified backtest run (the report `npm run backtest:verify`
// writes, whose every trade matched the independent SQL reproduction) and replays
// them through the real replay-service (auth-service and replay-service running):
// one session per pair over the run's window on H1, stepped bar by bar through the
// /replay socket. When the clock completes the bar a trade's signal came from, the
// tool sends what the strategy did: a close (POST .../positions/:id/close) and/or a
// market order (POST .../orders). Replay fills them at the next minute's open, the
// first minute of the backtester's fill bar; the last trade is closed by ending the
// session at the end of the data (the backtester's END_OF_DATA at the last close).
// Every trade's side, entry/exit bar, fill points, exit reason and net USD cents, and
// the totals, must be equal. Writes docs/validation/replay-equivalence.md; exits 1 on
// any difference or empty input.
//
//   npm run replay:verify -- [--pairs EUR_USD,XAU_USD,USD_JPY]
//                            [--verified docs/validation/backtest-verification.md]
//                            [--report docs/validation/replay-equivalence.md]
//
// The signal bar of a fill is the H1 bar before it, read from historical_candles_1h
// with the main DB login (read only). Registers a fresh user (replayverify_*).
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import { io, Socket } from 'socket.io-client';
import { compareTrades, Comparison, ReplayedTrade } from './compare';
import { parseVerifiedReport, VerifiedRun } from './verified-report';

const REPO_ROOT = resolve(__dirname, '../../..');

interface Options {
  pairs: string[];
  verified: string;
  report: string;
}

function parseOptions(argv: string[]): Options {
  const get = (flag: string, fallback: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  return {
    pairs: get('--pairs', 'EUR_USD,XAU_USD,USD_JPY').split(','),
    verified: resolve(REPO_ROOT, get('--verified', 'docs/validation/backtest-verification.md')),
    report: resolve(REPO_ROOT, get('--report', 'docs/validation/replay-equivalence.md')),
  };
}

interface PositionView {
  id: string; side: 'BUY' | 'SELL'; status: string; entryTime: string | null; entryPrice: string | null;
  exitTime: string | null; exitPrice: string | null; exitReason: ReplayedTrade['exitReason'] | null; realizedPnlUsd: string | null;
}

const toPoints = (price: string) => Number(price.replace('.', ''));
const toCents = (usd: string) => Math.round(Number(usd) * 100);

class Api {
  constructor(private readonly base: string, private readonly tokens: Tokens) {}

  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.tokens.current}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${text}`);
    return JSON.parse(text) as T;
  }
}

// The access token, kept fresh for a run that outlasts it (three pairs take about 15 minutes, the token
// lasts JWT_ACCESS_EXPIRES = 15m): every REFRESH_EVERY_MS the tool logs in again, uses the new token for
// REST and sends it as 'reauth' on the open replay socket, as the Replay page does. Without it,
// replay-service closes the socket at the token's expiry (step 7) and the run stops.
const REFRESH_EVERY_MS = 10 * 60_000;
class Tokens {
  private listeners: ((token: string) => void)[] = [];
  private timer: NodeJS.Timeout | undefined;
  constructor(public current: string, private readonly authUrl: string, private readonly login: { email: string; password: string }) {}

  start(): void {
    this.timer = setInterval(() => void this.renew().catch((err) => console.error(`token renewal failed: ${err}`)), REFRESH_EVERY_MS);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  onRenew(listener: (token: string) => void): () => void {
    this.listeners.push(listener);
    return () => { this.listeners = this.listeners.filter((l) => l !== listener); };
  }

  private async renew(): Promise<void> {
    const res = await fetch(`${this.authUrl}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(this.login),
    });
    if (!res.ok) throw new Error(`login: HTTP ${res.status}`);
    this.current = ((await res.json()) as { accessToken: string }).accessToken;
    this.listeners.forEach((l) => l(this.current));
  }
}

async function register(authUrl: string): Promise<{ tokens: Tokens; user: string }> {
  const id = randomBytes(4).toString('hex');
  const fresh = { email: `replayverify_${id}@example.com`, username: `rverify_${id}`,
    password: `Verify@${randomBytes(6).toString('hex')}1A`, firstName: 'Replay', lastName: 'Verify' };
  const res = await fetch(`${authUrl}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fresh),
  });
  if (!res.ok) throw new Error(`register: HTTP ${res.status} ${await res.text()}`);
  const token = ((await res.json()) as { accessToken: string }).accessToken;
  return { tokens: new Tokens(token, authUrl, { email: fresh.email, password: fresh.password }), user: fresh.email };
}

// The H1 bar before `hour` (the bar whose close produced the signal)
async function signalBar(db: Client, pair: string, hour: string): Promise<string> {
  const { rows } = await db.query(
    'SELECT max(bucket) AS b FROM historical_candles_1h WHERE pair = $1 AND bucket < $2', [pair, `${hour}:00Z`]);
  if (!rows[0].b) throw new Error(`${pair}: no H1 bar before ${hour}`);
  return new Date(rows[0].b).toISOString().slice(0, 16);
}

interface PairResult {
  pair: string;
  sessionId: string;
  steps: number;
  seconds: number;
  finalBalance: string;
  replayed: ReplayedTrade[];
  comparison: Comparison;
}

// A command's acknowledgement, or an error: a socket that went away must fail the run, not hang it
const ACK_TIMEOUT_MS = 30_000;

async function replayPair(db: Client, replayUrl: string, tokens: Tokens, pair: string, run: VerifiedRun): Promise<PairResult> {
  const verified = run.pairs.get(pair);
  if (!verified || verified.length === 0) throw new Error(`${pair}: no verified trades in the report`);

  // What to do when the clock completes a bar: closes first, then opens (as the backtester)
  const actions = new Map<string, { close: number[]; open: number[] }>();
  const at = (bar: string) => {
    const existing = actions.get(bar);
    if (existing) return existing;
    const created = { close: [] as number[], open: [] as number[] };
    actions.set(bar, created);
    return created;
  };
  for (const [i, t] of verified.entries()) {
    at(await signalBar(db, pair, t.entryHour)).open.push(i);
    if (t.exit === 'SIGNAL') at(await signalBar(db, pair, t.exitHour)).close.push(i);
    else if (t.exit !== 'END_OF_DATA') throw new Error(`${pair} #${t.n}: ${t.exit} exits are not replayed by this tool`);
  }

  const api = new Api(`${replayUrl}/api/replay`, tokens);
  const session = await api.call<{ id: string; clockTime: string }>('POST', '/sessions', {
    instrument: pair.replace('/', '_'), startTime: `${run.from}T00:00Z`, timeframe: '1h', startingBalance: run.capital,
  });
  const socket: Socket = io(`${replayUrl}/replay`, {
    path: '/api/replay/socket.io', auth: (cb) => cb({ token: tokens.current }), transports: ['websocket'],
  });
  const stopRenewals = tokens.onRenew((token) => {
    socket.timeout(ACK_TIMEOUT_MS).emitWithAck('reauth', { token }).then(
      (a: { ok: boolean; error?: string }) => { if (!a.ok) console.error(`reauth refused: ${a.error}`); },
      () => console.error('reauth: no acknowledgement'));
  });
  const positions = new Map<string, PositionView>();
  socket.on('positions', (list: PositionView[]) => list.forEach((p) => positions.set(p.id, p)));
  await new Promise((ok, fail) => { socket.once('state', ok); socket.once('connect_error', fail); });
  const ack = <T>(command: string) => socket.timeout(ACK_TIMEOUT_MS).emitWithAck(command, {}) as
    Promise<{ ok: boolean; result: T; error?: string }>;

  const lastDay = Date.parse(`${run.to}T00:00Z`) + 86_400_000;
  const positionOf = new Map<number, string>();
  const started = Date.now();
  let steps = 0;
  try {
    for (;;) {
      const step = await ack<{ session: { clockTime: string }; endOfData: boolean; minutes: number }>('step');
      if (!step.ok) throw new Error(`step: ${step.error}`);
      steps++;
      if (step.result.endOfData || Date.parse(step.result.session.clockTime) >= lastDay) break;
      const bar = `${step.result.session.clockTime.slice(0, 13)}:00`; // the H1 bar just completed
      const todo = actions.get(bar);
      if (!todo) continue;
      for (const i of todo.close) {
        await api.call('POST', `/sessions/active/positions/${positionOf.get(i)}/close`);
      }
      for (const i of todo.open) {
        const placed = await api.call<{ position: { id: string } }>('POST', '/sessions/active/orders',
          { side: verified[i].side, lots: run.lots });
        positionOf.set(i, placed.position.id);
      }
      actions.delete(bar);
    }
    if (actions.size > 0) throw new Error(`${pair}: ${actions.size} signal bar(s) never reached (${[...actions.keys()][0]} ...)`);
    const ended = await api.call<{ session: { balance: string }; closed: PositionView[] }>('POST', '/sessions/active/end');
    ended.closed.forEach((p) => positions.set(p.id, p));

    const replayed: ReplayedTrade[] = verified.map((_, i) => {
      const p = positions.get(positionOf.get(i) ?? '');
      if (!p || p.status !== 'CLOSED' || !p.entryTime || !p.entryPrice || !p.exitTime || !p.exitPrice || !p.exitReason
        || p.realizedPnlUsd === null) {
        throw new Error(`${pair} #${i + 1}: position ${positionOf.get(i)} is not a closed trade (${p?.status})`);
      }
      return {
        side: p.side, entryTime: p.entryTime, entryPoints: toPoints(p.entryPrice), exitTime: p.exitTime,
        exitPoints: toPoints(p.exitPrice), exitReason: p.exitReason, netCents: toCents(p.realizedPnlUsd),
      };
    });
    const comparison = compareTrades(verified, replayed);
    const expectedBalance = ((Math.round(run.capital * 100) + comparison.verifiedNetCents) / 100).toFixed(2);
    if (ended.session.balance !== expectedBalance) {
      comparison.ok = false;
      comparison.mismatches.push({ trade: 0, field: 'final balance', verified: expectedBalance, replayed: ended.session.balance });
    }
    return {
      pair, sessionId: session.id, steps, seconds: Math.round((Date.now() - started) / 1000),
      finalBalance: ended.session.balance, replayed, comparison,
    };
  } finally {
    stopRenewals();
    socket.disconnect();
  }
}

const usd = (cents: number) => (cents / 100).toFixed(2);

function report(run: VerifiedRun, results: PairResult[], user: string, commit: string, source: string): string {
  const lines: string[] = [];
  lines.push('# Replay equivalence (step 6b-1)', '');
  lines.push(`Generated by \`npm run replay:verify\` on ${new Date().toISOString()} at commit \`${commit}\`, as \`${user}\`.`, '');
  lines.push(`The verified trades of \`${source}\` (MA crossover ${run.fast}/${run.slow}, H1, ${run.from} to ${run.to}, ` +
    `${run.lots} lot, $${run.capital}; every trade matched the independent SQL reproduction) were replayed through the ` +
    'real replay-service: one session per pair on H1, stepped bar by bar over the /replay socket; when the clock ' +
    'completed a signal bar the tool sent the close and/or the market order, which replay filled at the next ' +
    "minute's open; the last trade closed by ending the session at the end of the data. Compared per trade: side, " +
    'entry and exit H1 bar, fill points, exit reason (SIGNAL = MANUAL, END_OF_DATA = SESSION_END) and net USD ' +
    'cents; then the total and the final balance.', '');
  lines.push('| Pair | Session | Steps | Time | Trades (verified / replayed) | Net USD (verified / replayed) | Final balance | Result |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    const c = r.comparison;
    lines.push(`| ${r.pair} | \`${r.sessionId}\` | ${r.steps} | ${r.seconds} s | ${run.pairs.get(r.pair)?.length} / ${r.replayed.length} | ` +
      `${usd(c.verifiedNetCents)} / ${usd(c.replayedNetCents)} | ${r.finalBalance} | ` +
      `${c.ok ? `**match** (${c.compared} trades)` : '**DIFFERS**'} |`);
  }
  lines.push('');
  for (const r of results) {
    lines.push(`## ${r.pair}`, '');
    const c = r.comparison;
    if (c.errors.length) lines.push(...c.errors.map((e) => `- **Error:** ${e}`), '');
    if (c.mismatches.length) {
      lines.push('| Trade | Field | Verified | Replayed |', '|---|---|---|---|');
      lines.push(...c.mismatches.map((m) => `| ${m.trade || 'total'} | ${m.field} | ${m.verified} | ${m.replayed} |`), '');
    } else if (c.ok) {
      lines.push(`All ${c.compared} trades, the total and the final balance match exactly.`, '');
    }
    lines.push('<details><summary>Every replayed trade</summary>', '');
    lines.push('| # | Side | Entry minute (UTC) | Entry pts | Exit minute (UTC) | Exit pts | Exit | Net USD |');
    lines.push('|---|---|---|---|---|---|---|---|');
    r.replayed.forEach((t, i) => lines.push(`| ${i + 1} | ${t.side} | ${t.entryTime.slice(0, 16)} | ${t.entryPoints} | ` +
      `${t.exitTime.slice(0, 16)} | ${t.exitPoints} | ${t.exitReason} | ${usd(t.netCents)} |`));
    lines.push('', '</details>', '');
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  process.loadEnvFile(join(REPO_ROOT, '.env'));
  const o = parseOptions(process.argv.slice(2));
  const authUrl = process.env['VERIFY_AUTH_URL'] ?? 'http://localhost:3000/api';
  const replayUrl = process.env['VERIFY_REPLAY_URL'] ?? 'http://localhost:3008';
  const run = parseVerifiedReport(readFileSync(o.verified, 'utf8'));
  const env = process.env;
  const db = new Client({
    host: env['DB_HOST'] || 'localhost', port: Number(env['DB_PORT']), user: env['DB_USER'],
    password: env['DB_PASS'], database: env['DB_NAME'],
  });
  await db.connect();
  const results: PairResult[] = [];
  let tokensInUse: Tokens | undefined;
  try {
    await db.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
    const { tokens, user } = await register(authUrl);
    tokensInUse = tokens;
    tokens.start();
    for (const instrument of o.pairs) {
      const pair = instrument.replace('_', '/');
      const r = await replayPair(db, replayUrl, tokens, pair, run);
      results.push(r);
      console.log(`${instrument}: ${r.comparison.compared} trades compared in ${r.steps} steps (${r.seconds} s), ` +
        `net ${usd(r.comparison.replayedNetCents)} USD: ${r.comparison.ok ? 'MATCH' : 'DIFFERS'}`);
    }
    const commit = execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT }).toString().trim();
    writeFileSync(o.report, report(run, results, user, commit, o.verified.slice(REPO_ROOT.length + 1).replace(/\\/g, '/')));
    console.log(`report: ${o.report}`);
  } finally {
    tokensInUse?.stop();
    await db.end();
  }
  if (results.length === 0 || results.some((r) => !r.comparison.ok)) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
