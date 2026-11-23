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
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
    return { status: r.status, text, json: text ? JSON.parse(text) : null };
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
    const state = (await next('state')) as State;
    // every command names the session this socket was given
    const ack = (cmd: string, body?: object) => new Promise<{ ok: boolean; error?: string }>(
      (ok) => socket.emit(cmd, { sessionId: state.session?.id, ...body }, ok));
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
  const s1 = created.json.id as string;
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

  const buy = await rest('POST', `/sessions/${s1}/orders`,
    { side: 'BUY', lots: 0.1, stopLoss: Number(level(clockBar, -100, d)), takeProfit: Number(level(clockBar, 100, d)) });
  save('order-201-pending', 'rest', 'POST /orders BUY 0.1 lots, SL bid-100 points, TP bid+100 points', buy.text, buy.status);
  save('positions-pending', 'socket', "'positions' after the order", json(await c.next('positions')));
  save('account-after-order', 'socket', "'account' after the order", json(await c.next('account')));
  const sell = await rest('POST', `/sessions/${s1}/orders`, { side: 'SELL', lots: 0.2 });
  if (sell.status !== 201) throw new Error(`sell: ${sell.text}`);
  const wrong = await rest('POST', `/sessions/${s1}/orders`, { side: 'BUY', lots: 0.1, stopLoss: Number(level(clockBar, 50, d)) });
  save('order-400-sl-side', 'rest', 'POST /orders BUY with the stop loss above the bid', wrong.text, wrong.status);
  const margin = await rest('POST', `/sessions/${s1}/orders`, { side: 'BUY', lots: 100 });
  save('order-400-margin', 'rest', 'POST /orders BUY 100 lots on 10,000 USD', margin.text, margin.status);
  const toCancel = await rest('POST', `/sessions/${s1}/orders`, { side: 'BUY', lots: 0.05 });
  const cancelled = await rest('POST', `/sessions/${s1}/orders/${toCancel.json.position.id}/cancel`);
  save('cancel-200', 'rest', 'POST /orders/:id/cancel of a pending order', cancelled.text, cancelled.status);
  c.queue.length = 0;

  await c.ack('step');
  save('positions-filled', 'socket', "'positions' from the step that filled both orders", json(await c.next('positions')));
  c.close();
  c = await connect();
  save('state-open-positions', 'socket', "'state' with a long and a short open", json(c.state));

  const closing = await rest('POST', `/sessions/${s1}/positions/${sell.json.position.id}/close`);
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

  await rest('POST', `/sessions/${s1}/orders`, { side: 'SELL', lots: 0.3 });
  await c.ack('step');
  c.close();
  c = await connect();
  save('state-closed-trades', 'socket', "'state' with two closed trades and an open short", json(c.state));
  const ended = await rest('POST', `/sessions/${s1}/end`);
  save('end-200', 'rest', 'POST /sessions/:id/end with one position open', ended.text, ended.status);
  save('ended', 'socket', "'ended' after the end", json(await c.next('ended')));
  c.close();

  // ── EUR/USD, 2022-03-16 17:58 UTC on 1m: the FOMC decision at 18:00, trade paging, statistics ──
  const fomc = await rest('POST', '/sessions', { instrument: 'EUR_USD', startTime: '2022-03-16T17:58Z', timeframe: '1m', startingBalance: 10000 });
  if (fomc.status !== 201) throw new Error(`fomc session: ${fomc.text}`);
  const sid = fomc.json.id as string;
  c = await connect();
  save('state-calendar-before', 'socket', "'state' at 17:58 before the FOMC decision at 18:00 (calendar covered, no event yet)", json(c.state));
  const empty = await rest('GET', `/sessions/${sid}/stats`);
  save('stats-200-empty', 'rest', 'GET /sessions/:id/stats before any trade', empty.text, empty.status);
  c.queue.length = 0;
  await c.ack('step'); // 17:59
  if (c.queue.some((e) => e.event === 'calendar')) throw new Error('a calendar event before its time');
  await c.ack('step'); // 18:00
  save('calendar-fomc', 'socket', "'calendar' from the step that reached the 18:00 FOMC decision", json(await c.next('calendar')));
  c.close();
  c = await connect();
  save('state-calendar-after', 'socket', "'state' at 18:00 with the FOMC decision", json(c.state));
  // 21 trades closed in one minute: a full first page with a cursor, then one more
  const opened: string[] = [];
  for (let i = 0; i < 21; i++) {
    const o = await rest('POST', `/sessions/${sid}/orders`, { side: i % 2 === 0 ? 'BUY' : 'SELL', lots: 0.01 });
    if (o.status !== 201) throw new Error(`order: ${o.text}`);
    opened.push(o.json.position.id);
  }
  for (let i = 0; i < 5; i++) await c.ack('step');
  for (const pid of opened) {
    const r = await rest('POST', `/sessions/${sid}/positions/${pid}/close`);
    if (r.status !== 200) throw new Error(`close: ${r.text}`);
  }
  await c.ack('step');
  const page1 = await rest('GET', `/sessions/${sid}/trades`);
  save('trades-200-page1', 'rest', 'GET /sessions/:id/trades: 20 of 21 trades closed in one minute', page1.text, page1.status);
  const page2 = await rest('GET', `/sessions/${sid}/trades?cursor=${page1.json.nextCursor}`);
  save('trades-200-page2', 'rest', 'GET /sessions/:id/trades?cursor=: the last of the 21', page2.text, page2.status);
  const later = await rest('POST', `/sessions/${sid}/orders`, { side: 'BUY', lots: 0.02 });
  await c.ack('step');
  await rest('POST', `/sessions/${sid}/positions/${later.json.position.id}/close`);
  c.queue.length = 0;
  await c.ack('step');
  save('positions-closed-later', 'socket', "'positions' from the step that closed a 22nd trade, after the pages were loaded",
    json(await c.next('positions')));
  const stats = await rest('GET', `/sessions/${sid}/stats`);
  save('stats-200', 'rest', 'GET /sessions/:id/stats after the 22 trades', stats.text, stats.status);
  const missing = await rest('GET', `/sessions/${randomUUID()}/trades`);
  save('trades-404', 'rest', 'GET /sessions/:id/trades of a session the user does not own', missing.text, missing.status);
  await rest('POST', `/sessions/${sid}/end`);
  c.close();

  // ── USD/JPY: P&L converted at the price ──
  const jpy = (await rest('POST', '/sessions', { instrument: 'USD_JPY', startTime: '2016-06-23T22:00Z', timeframe: '1h', startingBalance: 25000 })).json.id as string;
  c = await connect();
  await rest('POST', `/sessions/${jpy}/orders`, { side: 'BUY', lots: 0.5 });
  await rest('POST', `/sessions/${jpy}/orders`, { side: 'SELL', lots: 0.3 });
  await c.ack('step');
  await c.ack('step');
  c.close();
  c = await connect();
  save('state-usdjpy-open-positions', 'socket', "'state' of USD/JPY (2016-06-24, Brexit vote night) with a long and a short open", json(c.state));
  await rest('POST', `/sessions/${jpy}/end`);
  c.close();

  // ── The end of the history ──
  const last = (await rest('POST', '/sessions', { instrument: 'EUR_USD', startTime: '2022-12-30T20:30Z', timeframe: '1h', startingBalance: 10000 })).json.id as string;
  c = await connect();
  c.queue.length = 0;
  for (let i = 0; i < 5; i++) if (!(await c.ack('step')).ok) break;
  save('end-of-data', 'socket', "'endOfData' at the pair's last minute", json(await c.next('endOfData')));
  save('status-end-of-data', 'socket', "'status' at the end of the data (END_OF_DATA)",
    json(await c.next('status', 10_000, (p) => (p as { pauseReason?: string }).pauseReason === 'END_OF_DATA')));
  c.close();
  c = await connect();
  save('state-end-of-data', 'socket', "'state' on reconnect at the end of the data", json(c.state));
  await rest('POST', `/sessions/${last}/end`);
  c.close();

  // ── My replays: several sessions, switching, rename, delete ──
  // a title with markup: the page must show it as text
  const a = await rest('POST', '/sessions', { instrument: 'GBP_USD', startTime: '2019-12-12T21:00Z', timeframe: '15m', title: '<b>UK election</b> & GBP' });
  if (a.status !== 201) throw new Error(`session a: ${a.text}`);
  const b = await rest('POST', '/sessions', { instrument: 'XAU_USD', startTime: '2020-03-09T08:00Z', timeframe: '1h' });
  if (b.status !== 201) throw new Error(`session b: ${b.text}`);
  c = await connect();
  save('state-before-switch', 'socket', "'state' on connect: the latest created session (XAU/USD), before another is opened", json(c.state));
  c.queue.length = 0;
  const openedA = await rest('POST', `/sessions/${a.json.id}/open`);
  save('open-200-paused', 'rest', 'POST /sessions/:id/open of a paused session: its state, now the current one', openedA.text, openedA.status);
  save('switched', 'socket', "'switched' to the tab still showing the other session", json(await c.next('switched')));
  c.close();
  const openedEnded = await rest('POST', `/sessions/${s1}/open`);
  save('open-200-ended', 'rest', 'POST /sessions/:id/open of an ENDED session: read-only state up to its end', openedEnded.text, openedEnded.status);
  const openMissing = await rest('POST', `/sessions/${randomUUID()}/open`);
  save('open-404', 'rest', 'POST /sessions/:id/open of a session the user does not own', openMissing.text, openMissing.status);

  const renamed = await rest('PATCH', `/sessions/${b.json.id}`, { title: '  Gold, March 2020 crash  ' });
  save('rename-200', 'rest', 'PATCH /sessions/:id with a title (trimmed by the server)', renamed.text, renamed.status);
  const tooLong = await rest('PATCH', `/sessions/${b.json.id}`, { title: 'x'.repeat(61) });
  save('rename-400-too-long', 'rest', 'PATCH /sessions/:id with 61 characters', tooLong.text, tooLong.status);
  const notEnded = await rest('DELETE', `/sessions/${a.json.id}`);
  save('delete-409-paused', 'rest', 'DELETE /sessions/:id of a paused session', notEnded.text, notEnded.status);
  const deleted = await rest('DELETE', `/sessions/${jpy}`);
  save('delete-204', 'rest', 'DELETE /sessions/:id of an ENDED session (no body)', deleted.text, deleted.status);

  // 21 sessions in all (4 ended, USD/JPY deleted, a, b and 16 more): a second page (20 a page)
  for (let i = 0; i < 16; i++) {
    const r = await rest('POST', '/sessions', { instrument: 'EUR_USD', startTime: `2021-0${(i % 9) + 1}-15T12:00Z`, timeframe: '1h' });
    if (r.status !== 201) throw new Error(`filler session: ${r.text}`);
  }
  await rest('POST', `/sessions/${a.json.id}/open`);
  const list1 = await rest('GET', '/sessions');
  save('sessions-200-page1', 'rest', 'GET /sessions: the first 20 of 21 sessions, last opened first', list1.text, list1.status);
  if (list1.json.sessions.length !== 20 || !list1.json.nextCursor) throw new Error('expected a full first page with a cursor');
  const list2 = await rest('GET', `/sessions?cursor=${list1.json.nextCursor}`);
  save('sessions-200-page2', 'rest', 'GET /sessions?cursor=: the last one', list2.text, list2.status);

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
    `imported Dukascopy history, at commit \`${commit}\`, as the throwaway user \`${user}\` (deleted`,
    'afterwards with `tools/ops/delete-verification-users.ts`). Nothing here is written or edited by hand; this README',
    'is written by the recorder too.',
    '',
    '- **REST** (kind rest): the response body byte for byte.',
    '- **Socket** (kind socket): `JSON.stringify` of the payload socket.io-client delivered. Socket.IO sends JSON, so',
    '  this is the received object, re-serialized compactly.',
    '',
    'Sessions: EUR/USD from 2022-03-01 09:30 UTC on 1m (a long 0.1 lot with SL/TP 100 points from the bid, closed by',
    'its SL; a short 0.2 closed manually; a cancelled order; ended with a short open), USD/JPY from 2016-06-23 22:00',
    'UTC on 1h (a long and a short open on the Brexit-vote night), EUR/USD from 2022-03-16 17:58 UTC on 1m across',
    'the FOMC decision at 18:00 (calendar; 21 trades closed in one minute for paging, a 22nd later; statistics), and',
    'EUR/USD from 2022-12-30 20:30 UTC stepped to the end of the history. My replays: GBP/USD (a title with markup)',
    'and XAU/USD sessions, opened and switched, renamed, a paused one refused for deletion and the USD/JPY one deleted,',
    'then 16 more EUR/USD sessions for a second list page.',
    '',
    '| File | Kind | What | HTTP | Recorded (UTC) | sha256 |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
