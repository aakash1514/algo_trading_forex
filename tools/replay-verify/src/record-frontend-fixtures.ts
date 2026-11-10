// Records the Replay page's test fixtures from the real running services (auth-service
// and replay-service) and the imported history: a throwaway user (replayfixture_*)
// creates EUR/USD and USD/JPY sessions on real dates, steps, plays, places, cancels and
// closes orders and ends them. REST bodies are saved byte for byte; socket payloads as
// JSON.stringify of what socket.io-client delivered (socket messages are JSON on the
// wire, so this is the received object). manifest.json lists every file with its
// sha256; nothing is edited by hand. Afterwards run tools/ops/delete-verification-users.ts.
//
//   npx ts-node --transpile-only --project tools/replay-verify/tsconfig.app.json \
//     tools/replay-verify/src/record-frontend-fixtures.ts
import { execSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { io, Socket } from 'socket.io-client';

const REPO_ROOT = resolve(__dirname, '../../..');
const OUT = join(REPO_ROOT, 'apps/frontend/src/components/replay/__fixtures__');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Entry { file: string; kind: 'rest' | 'socket'; what: string; status?: number; recorded_at: string; sha256: string }
const manifest: Record<string, Entry> = {};
const commit = execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT }).toString().trim();

// REST fixtures name their expected status (create-201, order-400-...): anything else stops the run
function save(name: string, kind: Entry['kind'], what: string, body: string, status?: number): void {
  if (manifest[name]) throw new Error(`fixture ${name} recorded twice`);
  const expected = /-(\d{3})(?:-|$)/.exec(name)?.[1];
  if (kind === 'rest' && String(status) !== expected) throw new Error(`${name}: HTTP ${status} ${body}`);
  const file = `${name}.json`;
  writeFileSync(join(OUT, file), body);
  manifest[name] = {
    file, kind, what, ...(status === undefined ? {} : { status }),
    recorded_at: new Date().toISOString(), sha256: createHash('sha256').update(body).digest('hex'),
  };
  console.log(`${file}: ${what}${status === undefined ? '' : ` (HTTP ${status})`}`);
}

interface Pos { id: string; status: string; side: string; exitReason: string | null }
interface Bar { time: string; bid: { close: string }; ask: { close: string } }
interface State { session: { id: string; clockTime: string } | null; currentBar: Bar; positions: Pos[]; priceDecimals: number }

async function main(): Promise<void> {
  process.loadEnvFile(join(REPO_ROOT, '.env'));
  const authUrl = process.env['VERIFY_AUTH_URL'] ?? 'http://localhost:3000/api';
  const replayUrl = process.env['VERIFY_REPLAY_URL'] ?? 'http://localhost:3008';
  mkdirSync(OUT, { recursive: true });

  const id = randomBytes(4).toString('hex');
  const reg = await fetch(`${authUrl}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `replayfixture_${id}@example.com`, username: `rfix_${id}`,
      password: `Fix@${randomBytes(6).toString('hex')}1A`, firstName: 'Replay', lastName: 'Fixture' }),
  });
  if (!reg.ok) throw new Error(`register: HTTP ${reg.status} ${await reg.text()}`);
  const { accessToken: token } = (await reg.json()) as { accessToken: string };

  const rest = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${replayUrl}/api/replay${path}`, {
      method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status, text, json: JSON.parse(text) };
  };
  // A socket whose events are kept in order; next(event) waits for one not yet taken
  const connect = async () => {
    const socket: Socket = io(`${replayUrl}/replay`, { path: '/api/replay/socket.io', auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
    const queue: { event: string; payload: unknown }[] = [];
    socket.onAny((event: string, payload: unknown) => queue.push({ event, payload }));
    const next = async (event: string, timeoutMs = 10_000, match: (p: unknown) => boolean = () => true) => {
      for (const until = Date.now() + timeoutMs; Date.now() < until; await sleep(20)) {
        const i = queue.findIndex((e) => e.event === event && match(e.payload));
        if (i >= 0) return queue.splice(i, 1)[0].payload;
      }
      throw new Error(`no ${event} within ${timeoutMs} ms`);
    };
    const ack = (cmd: string, body?: unknown) => new Promise<{ ok: boolean; error?: string }>((ok) => socket.emit(cmd, body ?? {}, ok));
    const state = (await next('state')) as State;
    return { socket, queue, next, ack, state, close: () => socket.disconnect() };
  };
  const json = (payload: unknown) => JSON.stringify(payload);
  const level = (bar: Bar, points: number, decimals: number) =>
    ((Number(bar.bid.close.replace('.', '')) + points) / 10 ** decimals).toFixed(decimals);

  // ── EUR/USD, 2022-03-01 09:30 UTC on 1m ──
  let c = await connect();
  save('state-no-session', 'socket', "'state' on connect without a session", json(c.state));
  const created = await rest('POST', '/sessions', { instrument: 'EUR_USD', startTime: '2022-03-01T09:30Z', timeframe: '1m', startingBalance: 10000 });
  save('create-201', 'rest', 'POST /sessions {EUR_USD, 2022-03-01T09:30Z, 1m, 10000}', created.text, created.status);
  const again = await rest('POST', '/sessions', { instrument: 'XAU_USD', startTime: '2015-06-01T08:00Z', timeframe: '1h', startingBalance: 10000 });
  save('create-409', 'rest', 'POST /sessions while one is active', again.text, again.status);
  c.close();

  c = await connect();
  save('state-paused', 'socket', "'state' on connect: the new session, PAUSED", json(c.state));
  for (let i = 0; i < 11; i++) await c.ack('step');
  c.queue.length = 0;
  const stepped = await c.ack('step');
  if (!stepped.ok) throw new Error(`step: ${stepped.error}`);
  const bar = await c.next('bar');
  save('bar-1m', 'socket', "'bar' after a step on 1m", json(bar));
  const { bar: clockBar } = bar as { bar: Bar };
  const d = c.state.priceDecimals;

  const buy = await rest('POST', '/sessions/active/orders',
    { side: 'BUY', lots: 0.1, stopLoss: Number(level(clockBar, -100, d)), takeProfit: Number(level(clockBar, 100, d)) });
  save('order-201-pending', 'rest', 'POST /orders BUY 0.1 lots, SL bid-100 points, TP bid+100 points', buy.text, buy.status);
  save('positions-pending', 'socket', "'positions' after the order", json(await c.next('positions')));
  save('account-after-order', 'socket', "'account' after the order", json(await c.next('account')));
  const sell = await rest('POST', '/sessions/active/orders', { side: 'SELL', lots: 0.2 });
  if (sell.status !== 201) throw new Error(`sell: ${sell.text}`);
  const wrong = await rest('POST', '/sessions/active/orders', { side: 'BUY', lots: 0.1, stopLoss: Number(level(clockBar, 50, d)) });
  save('order-400-sl-side', 'rest', 'POST /orders BUY with the stop loss above the bid', wrong.text, wrong.status);
  const margin = await rest('POST', '/sessions/active/orders', { side: 'BUY', lots: 100 });
  save('order-400-margin', 'rest', 'POST /orders BUY 100 lots on 10,000 USD', margin.text, margin.status);
  const toCancel = await rest('POST', '/sessions/active/orders', { side: 'BUY', lots: 0.05 });
  const cancelled = await rest('POST', `/sessions/active/orders/${toCancel.json.position.id}/cancel`);
  save('cancel-200', 'rest', 'POST /orders/:id/cancel of a pending order', cancelled.text, cancelled.status);
  c.queue.length = 0;

  await c.ack('step');
  save('positions-filled', 'socket', "'positions' from the step that filled both orders", json(await c.next('positions')));
  c.close();
  c = await connect();
  save('state-open-positions', 'socket', "'state' with a long and a short open", json(c.state));

  const closing = await rest('POST', `/sessions/active/positions/${sell.json.position.id}/close`);
  save('close-200', 'rest', 'POST /positions/:id/close (pending until the next minute)', closing.text, closing.status);
  c.queue.length = 0;
  await c.ack('step');
  save('positions-closed-manual', 'socket', "'positions' from the step that closed the short (MANUAL)", json(await c.next('positions')));

  await c.ack('setSpeed', { speedMs: 500 });
  await c.ack('play');
  c.queue.length = 0;
  const exit = await c.next('positions', 120_000,
    (p) => (p as Pos[]).some((x) => x.id === buy.json.position.id && x.status === 'CLOSED'));
  save('positions-closed-level', 'socket', "'positions' when the long closed at its SL or TP while playing", json(exit));
  await c.ack('pause');
  save('status-paused-user', 'socket', "'status' after pause (USER)", json(await c.next('status', 10_000,
    (p) => (p as { pauseReason?: string }).pauseReason === 'USER')));

  await rest('POST', '/sessions/active/orders', { side: 'SELL', lots: 0.3 });
  await c.ack('step');
  c.close();
  c = await connect();
  save('state-closed-trades', 'socket', "'state' with two closed trades and an open short", json(c.state));
  const ended = await rest('POST', '/sessions/active/end');
  save('end-200', 'rest', 'POST /sessions/active/end with one position open', ended.text, ended.status);
  save('ended', 'socket', "'ended' after the end", json(await c.next('ended')));
  c.close();

  // ── USD/JPY: P&L converted at the price ──
  await rest('POST', '/sessions', { instrument: 'USD_JPY', startTime: '2016-06-23T22:00Z', timeframe: '1h', startingBalance: 25000 });
  c = await connect();
  await rest('POST', '/sessions/active/orders', { side: 'BUY', lots: 0.5 });
  await rest('POST', '/sessions/active/orders', { side: 'SELL', lots: 0.3 });
  await c.ack('step');
  await c.ack('step');
  c.close();
  c = await connect();
  save('state-usdjpy-open-positions', 'socket', "'state' of USD/JPY (2016-06-24, Brexit vote night) with a long and a short open", json(c.state));
  await rest('POST', '/sessions/active/end');
  c.close();

  // ── The end of the history ──
  await rest('POST', '/sessions', { instrument: 'EUR_USD', startTime: '2022-12-30T20:30Z', timeframe: '1h', startingBalance: 10000 });
  c = await connect();
  c.queue.length = 0;
  for (let i = 0; i < 5; i++) if (!(await c.ack('step')).ok) break;
  save('end-of-data', 'socket', "'endOfData' at the pair's last minute", json(await c.next('endOfData')));
  save('status-end-of-data', 'socket', "'status' at the end of the data (END_OF_DATA)",
    json(await c.next('status', 10_000, (p) => (p as { pauseReason?: string }).pauseReason === 'END_OF_DATA')));
  c.close();
  c = await connect();
  save('state-end-of-data', 'socket', "'state' on reconnect at the end of the data", json(c.state));
  await rest('POST', '/sessions/active/end');
  c.close();

  const sorted = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify({ commit, user: `replayfixture_${id}@example.com`, fixtures: sorted }, null, 1)}\n`);
  writeFileSync(join(OUT, 'README.md'), readme(`replayfixture_${id}@example.com`, sorted));
  console.log(`${Object.keys(manifest).length} fixtures at commit ${commit}, user replayfixture_${id}@example.com`);
}

function readme(user: string, fixtures: Record<string, Entry>): string {
  const rows = Object.values(fixtures).map((e) =>
    `| ${e.file} | ${e.kind} | ${e.what} | ${e.status ?? '—'} | ${e.recorded_at.slice(0, 19)}Z | \`${e.sha256}\` |`);
  return [
    '# Replay page fixtures',
    '',
    'Real replay-service responses and socket events, recorded by',
    '`tools/replay-verify/src/record-frontend-fixtures.ts` against the running auth-service and replay-service and the',
    `imported Dukascopy history, at commit \`${commit}\` (step 6b-2), as the throwaway user \`${user}\` (deleted`,
    'afterwards with `tools/ops/delete-verification-users.ts`). Nothing here is written or edited by hand; this README',
    'is written by the recorder too.',
    '',
    '- **REST** (kind rest): the response body byte for byte.',
    '- **Socket** (kind socket): `JSON.stringify` of the payload socket.io-client delivered. Socket.IO sends JSON, so',
    '  this is the received object, re-serialized compactly.',
    '',
    'Sessions: EUR/USD from 2022-03-01 09:30 UTC on 1m (a long 0.1 lot with SL/TP 100 points from the bid, closed by',
    'its SL; a short 0.2 closed manually; a cancelled order; ended with a short open), USD/JPY from 2016-06-23 22:00',
    'UTC on 1h (a long and a short open on the Brexit-vote night), and EUR/USD from 2022-12-30 20:30 UTC stepped to',
    'the end of the history.',
    '',
    '| File | Kind | What | HTTP | Recorded (UTC) | sha256 |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
