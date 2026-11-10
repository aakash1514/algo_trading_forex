# Roadmap step 6b-2: the Replay page

**Outcome:** the bar replay from 6b-1 is usable in the browser at `/replay`. Pick a pair, a UTC start in 2010–2022, a
balance and a timeframe, then play (0.5/1/2 s per bar), step, switch timeframe and paper-trade against the history,
with a large REPLAY badge and the replay clock so it can't be taken for live prices. The only backend change is a
**pause reason** on the session, so the page can say why it is paused. A real Chromium run (Playwright) went through
the whole flow: three speeds measured at 1,997 / 1,010 / 511 ms per bar, an order with SL/TP that filled at the next
minute's open and closed by its SL (−$11.40, recomputed), a second tab, closing the tab and coming back, ending.

Branch `step-6b-2-replay-frontend` (2026-11-10), 5 feature commits plus this close-out, not merged.

## 1. What was built

| Commit | Group | What |
|---|---|---|
| `63d5197` | A | `replay_sessions.pause_reason` (migration `ReplayPauseReason`), set by pause / second socket / last socket leaving / boot / end of data, sent in `state` and `status`; a failed timer step now sends a `status` |
| `f334a35` | B | `/replay` in both navigations, the terminal banner links to it; start form, 409 → resume card, end with on-page confirmation, summary; `replay` slice, `useReplaySocket`, `replay.api.ts` |
| `8a24024` | C | Bid-candle chart (the terminal's options, now shared), REPLAY badge and clock, play/pause/step/speed/timeframe, status line, Connecting/Reconnecting |
| `dfce1cf` | D | Order panel, pending/open/closing rows with Cancel/Close, live P&L per position via `@forexedge/trading-sim`, closed trades, account strip |
| `421b681` | E | Fixture recorder (24 real responses/events), fixture and component tests, cleanup-tool prefixes |
| close-out | E | Playwright run + report and screenshots, Topbar replay mode, stale order note, BACKLOG, CLAUDE.md, this write-up |

## 2. The main frontend decisions, in plain words

**Where the data lives (state).** The server owns the replay: the clock, the fills and the money. The page never
computes them; it keeps the latest copy of what the server sent in one Redux slice (`replay`). A full `state` event
(sent on every connect and timeframe change) replaces everything. Smaller events replace only their part: `bar`
the current bar, `account` the account, `status` the session, and `positions` are merged in by id, so receiving the
same update twice (the REST response and the socket event for the same order) changes nothing.

**One socket per visit, and the token.** `useReplaySocket` opens one Socket.IO connection when the page opens and
closes it when you leave. It doesn't remember the access token. Socket.IO calls a small function each time it
(re)connects, and that function reads the current token from the store. So when another part of the app refreshes
the token, the socket isn't rebuilt. That matters: a disconnect pauses the replay as DISCONNECT. If the server
refuses a token (it expired), the hook uses the app's shared `refreshSession()` (one refresh in flight for the whole
app, because the refresh cookie rotates) and connects again. After any reconnect the server sends a PAUSED state;
the page never sends `play` by itself.

**Commands and their acknowledgements.** Play, pause, step, speed and timeframe are sent with
`emitWithAck` and a 10 s timeout. While one waits, every control is disabled (`pendingCommand`), so a double
click can't send two steps. A refusal shows the server's message.

**Chart updates.** lightweight-charts keeps its own copy of the bars, so React tells it what changed instead of
redrawing everything. A new full state bumps `stateVersion`, and the chart calls `setData` with every bar. A
`bar` event calls `update(bar)`: same start time redraws that candle in place (the partial bar grows minute by
minute), a later start time adds a candle. A bar for a different timeframe (one already on its way when you
switched) is ignored.

**Bid candles.** The terminal draws mid prices; replay draws the bid, like MetaTrader: the values are exact (a mid
can fall between two points) and a long's stop loss is checked on the bid. The ask is in the order panel.

**Exact numbers.** Prices and money arrive as decimal strings. The page keeps them as strings, compares prices as
integer points and adds money as BigInt cents; nothing passes through a float before it's displayed.

**Live P&L per position.** The server sends only the account's total unrealised P&L. Each row is computed with the
server's own function, `@forexedge/trading-sim`'s `markToMarketCents`, at the current bar's close (the clock
minute's close). A test checks that the rows add up to the server's total on three recorded states (EUR/USD and
USD/JPY). This is the frontend's first import from `libs/`.

**Never mistaken for live.** The REPLAY badge (amber), "Replay time: … UTC", "Historical Dukascopy data · bid
candles"; on /replay the Topbar hides the live price ticker and says "Historical replay" instead of "Live".

## 3. Errors hit, root cause, fix

| Error | Root cause | Fix |
|---|---|---|
| Every replay-service DB test: `getaddrinfo ENOTFOUND 127.0.0.1` | `.env` had `DB_HOST=127.0.0.1 ` with a trailing space (an IP with a space is looked up as a name) | Removed the space (`.env` isn't tracked) |
| `nx` "workspace out of sync"; `nx sync` removed ws-gateway's trading-sim reference | A stale project graph (`.nx/workspace-data`) missed a real import | `nx reset --only-workspace-data`, then the sync check was clean; the bad sync wasn't committed (CLAUDE.md gotcha) |
| `next build`: "BigInt literals are not available when targeting lower than ES2020" | The frontend inherited `es2015` from tsconfig.base | `target: ES2020` in the frontend tsconfig (type-checking only; SWC compiles) |
| Turbopack: "Specified module format (CommonJs) is not matching … (EcmaScript Modules)" in libs/common and libs/trading-sim | Their `package.json` say `"type": "commonjs"` while the sources use `import`; `transpilePackages` didn't help | Removed the `type` field (CommonJS stays Node's default); every dependent passed the affected checks |
| Recorder: the order came back 400 | It computed SL/TP from the first queued `bar` (an old minute), not the latest | Clear the queue before the last step; the recorder now stops on any unexpected HTTP status |
| A planted fault (no timeframe guard) passed the chart test | The test served the same parsed object twice; Immer saw the same reference and nothing re-rendered | Each serve parses the fixture afresh; the test asserts a same-time bar is redrawn; the planted fault now fails it |
| Browser screenshots: green "Live" in the Topbar on /replay; "Order placed" note stayed after the fill | A hard-coded indicator; the note had no reset | Topbar replay mode on /replay; the note clears when the clock moves |

## 4. Verification results

**Backend (group A).** replay-service with the DB/socket suites: **137/137** (134 before + 3 new; reason
assertions added to 6 existing tests). The two migration walks with `ReplayPauseReason`: domain-service 67/67,
market-data-import 67/67 (incl. the live-isolation fingerprint and the write scan).

**Equivalence after the backend change** (`npm run replay:verify`, `docs/validation/replay-equivalence.md`):

| Pair | H1 steps | Time | Trades (verified / replayed) | Net USD | Final balance | Result |
|---|---|---|---|---|---|---|
| EUR/USD | 6,240 | 248 s | 257 / 257 | -272.20 / -272.20 | 9,727.80 | match |
| XAU/USD | 5,915 | 230 s | 217 / 217 | -555.92 / -555.92 | 9,444.08 | match |
| USD/JPY | 6,240 | 209 s | 215 / 215 | 1,485.75 / 1,485.75 | 11,485.75 | match |

Same as 6b-1, to the cent (the pause reason doesn't touch stepping or money).

**Frontend tests.** 137 (93 before the step + 44): `lib/replay.spec.ts` 25, `components/replay/fixtures.spec.ts` 6,
`components/replay/ReplayClient.spec.tsx` 13; two banner assertions updated. The component tests use only the 24
recorded fixtures; every collection checked asserts it is non-empty.

**Affected checks before every commit** (`nx affected -t lint typecheck test build`): all green, 0 lint errors (the
7 frontend warnings are older files).

**Browser run** (`npm run replay:browser`, `docs/validation/replay-frontend-e2e.md`, screenshots in
`docs/validation/replay-frontend/`), EUR/USD from 2022-03-01 09:30 UTC on 1m, all checks pass:

| Step | Result | Screenshot |
|---|---|---|
| Start | opens PAUSED on 09:30 with the badge and clock | `01-start-form.png`, `02-session-open.png` |
| Speeds | 2 s → 1,997 ms, 1 s → 1,010 ms, 0.5 s → 511 ms (mean of 6 clock changes seen in the page) | `03-after-playing.png` |
| Order | 09:51, bid 1.11942: BUY 0.10, SL 1.11842, TP 1.12042 → Pending | `04-order-pending.png` |
| Fill | 09:52: Open at 1.11942, P&L +$0.60 (= the account's unrealised) | `05-order-filled.png` |
| Close | 10:09: Stop loss at 1.11842, −$11.40 = (111842 − 111942 − 14) × 10,000 / 10^5 | `06-trade-closed.png` |
| Second tab | first tab: "Paused: replay opened in another tab or window"; second: the resume card | `07-other-tab-first.png`, `08-other-tab-second.png` |
| Away and back | closed while playing; back: resume card at 10:11, unchanged 2 s later; Resume → "Paused: connection lost" | `09-resume-card.png`, `10-resumed.png` |
| End | on-page confirmation; summary $10,000.00 → $9,988.60, −$11.40, 1 trade | `11-end-confirm.png`, `12-summary.png` |

**Not rerun, by decision** (backtester and history untouched): the clean matrix with `nx reset`, `backtest:verify`,
`data:validate`.

**Cleanup:** 7 throwaway users deleted with `tools/ops/delete-verification-users.ts --apply` (4 `replayfixture_`, of which 3 were the recorder's runs and 1 its failed first run; 2 `replayui_`; 1 `replayverify_`): 15 replay sessions, 709 replay positions; after a final rerun of the browser script, 1 more `replayui_` (1 session, 1 position), 0 backtest runs. The user ids named in the reports belonged to them. Services stopped.

## 5. Commands

```sh
npm run migration:run                                   # ReplayPauseReason
RUN_DB_TESTS=true npx nx test replay-service --skip-nx-cache
npx nx test frontend --testFile=components/replay/ReplayClient.spec.tsx
# auth-service + replay-service running:
npx ts-node --transpile-only --project tools/replay-verify/tsconfig.app.json tools/replay-verify/src/record-frontend-fixtures.ts
npm run replay:verify -- --pairs EUR_USD,XAU_USD,USD_JPY
# + production frontend (npx nx build frontend && npx nx run frontend:serve:production):
npm run replay:browser
npx ts-node --transpile-only tools/ops/delete-verification-users.ts [--apply]
```

## 6. Interview Q&A

**How does the page stay in sync with a server-driven replay?**
It doesn't compute anything the server owns. One socket delivers a full state on connect and small events after
each change; a Redux slice applies them by kind (replace all, replace a part, merge positions by id). Because merges
are idempotent, the REST response and the socket event for the same order can both land in any order.

**Why not reconnect the socket when the access token changes?**
The server pauses a replay when the user's last socket leaves. Rebuilding the socket on every token refresh would
pause the replay every time the app refreshed its token. The socket reads the token lazily at each connect; an
expired one is refused at the handshake, refreshed through the app's single-flight refresh, and the socket
reconnects.

**How do you update a candlestick chart from a stream without redrawing it?**
A full state calls `setData` once; each bar event calls `update`. lightweight-charts replaces the last candle when
the time matches and appends when it's later. Bars for a timeframe you just left are dropped in the reducer.

**Per-position P&L isn't in the API. Why not compute it in the component?**
Because it would be a second implementation of the money rules. The page imports the pure trading-sim library the
server uses and proves the rows sum to the server's total on recorded data, including USD/JPY converted at the
price.

**How do you test a socket-driven page without inventing data?**
The fixtures are recorded from the running service on real history (REST bodies byte for byte, socket payloads as
received) with sha256 in a manifest. The tests replace only the transport: a fake socket that plays the recorded
events back, fetch answering with recorded bodies, and a chart stub that records calls. A planted fault was used
to prove the chart test can fail (it couldn't at first: see §3).

**What did the browser run catch that unit tests didn't?**
Two things a screenshot shows and an assertion doesn't: a hard-coded green "Live" in the Topbar on the Replay page,
and a success note that stayed after the order had filled.

## 7. Noticed, not done

- **The Topbar's "Live" indicator is hard-coded** (always green) on every other page too, even with no feed; on
  /replay it's replaced. The terminal should derive it from the feed status.
- **Trade count after more than 50 closed trades** is a lower bound (marked "+"); exact counts need the paged
  trades endpoint (BACKLOG 4).
- **The replay socket has no backoff beyond 10 attempts** (then "Connection lost" with Retry); fine for one user,
  revisit with deployment.
- **The date/time inputs are the browser's native pickers**, whose display follows the browser's locale; the
  values sent are always the UTC fields as typed.
- `npm install` reports the same audit findings as before (deferred since step 1); Playwright added none.
- Python's text mode on Windows wrote CRLF into files I edited with scripts during this step; caught by git's
  warning and normalized before committing (a tooling note, not a repo change).

## 8. PR text

````md
## Step 6b-2: the Replay page

The bar replay from 6b-1 in the browser at `/replay`: start (pair, UTC start in 2010–2022, balance, timeframe),
resume, play at 0.5/1/2 s per bar, step, switch timeframe, paper-trade with SL/TP, end with a summary. A large
REPLAY badge and the replay clock make it impossible to mistake for live prices.

### What's in it
- **Backend (only change):** `replay_sessions.pause_reason` (USER, OTHER_TAB, DISCONNECT, SERVER_RESTART,
  END_OF_DATA) in `state` and `status`; a failed timer step now tells the sockets.
- **Page:** navigation + terminal banner link; start form validated before sending; 409 → resume card; end with an
  on-page confirmation and a summary.
- **Playback:** bid candles with the terminal's chart setup, in-place updates of the current bar, controls held
  while a command awaits its acknowledgement, a status line per pause reason, Reconnecting state, token refresh
  without dropping the socket.
- **Trading:** order panel at the clock's bid/ask, SL/TP side and lot checks, pending/open/closing rows, live P&L
  per position via `@forexedge/trading-sim` (sums to the server's total), the last 50 closed trades, account strip.
- **Tests:** 24 fixtures recorded from the running service on real history (sha256 manifest), 44 new frontend
  tests; Playwright run with screenshots.

### Checks
- replay-service DB/socket suites 137/137; migration walks (domain-service, market-data-import incl. fingerprint and
  write scan) 67/67 each
- `replay:verify` EUR/USD 257/257 (−272.20), XAU/USD 217/217 (−555.92), USD/JPY 215/215 (+1,485.75): all match to the cent
- Frontend 137 tests; `nx affected -t lint typecheck test build` green before every commit
- `npm run replay:browser`: all checks pass (speeds 1,997 / 1,010 / 511 ms; SL close −$11.40; OTHER_TAB; back
  paused as DISCONNECT; summary)

### Not in this PR
Keyboard shortcuts, calendar events on the chart, replay statistics, paged closed trades, stop-out
(`docs/BACKLOG.md`).
````
