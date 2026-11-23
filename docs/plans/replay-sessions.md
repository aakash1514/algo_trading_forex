# Plan: "My replays" (session list, titles, switching, delete)

Branch `replay-sessions` from `replay-improvements` (stacked PR, base `replay-improvements`; retargeted to `main`
after PR #20 merges). Nothing is merged.

## Stop-condition check (done before planning)

**Several paused sessions per user need no change to order/fill/P&L/margin logic.** Every order, fill, step,
balance update and margin check is keyed by `session_id` (`ReplayOrderService`, `PlaybackService.advance`,
`ReplayStateService`), and margin is per session (its own balance, its own open + pending positions). What changes
is only *which* session the `active/*` routes and the socket commands resolve: today "the non-ENDED one", after
this change "the current one" (see 2). Delete touches only `replay_sessions` and `replay_positions` (the only FK
into `replay_sessions` is `replay_positions.session_id`). No stop condition triggers, but three points need your OK
(section 0).

## 0. Questions for you (each blocks one part)

**Q1. The one-active-session index has to go.** `replay_sessions_one_active_per_user` (unique on `user_id` WHERE
`status <> 'ENDED'`, migration ReplayTables) is exactly "at most one non-ENDED session per user", so two paused
sessions can't exist while it does. You asked for "no drops/renames". Options:
- **(a) recommended:** in the same migration, first create `replay_sessions_one_playing_per_user` (unique on
  `user_id` WHERE `status = 'PLAYING'`, the DB backstop for "only one plays"), then `DROP INDEX
  replay_sessions_one_active_per_user`. Rollback check (the old release on the new schema): its
  `findOne({ userId, status: Not('ENDED') })` returns one of the user's paused sessions (no defined order), and
  its create answers 409 because one exists. So the old release still works but may resume a different paused
  session than the one last used. Nothing breaks and no data is lost. `down()` recreates the old index, but only
  when no user has two non-ENDED rows (otherwise it fails with a clear message).
- (b) keep the index and refuse the feature: then "My replays" would list one paused + ended sessions only.

**Q2. The replay login gets DELETE on `replay_sessions` and `replay_positions` only.** Today the role is
SELECT/INSERT/UPDATE ("nothing is ever deleted"), and `session.db.spec.ts` and `create-replay-db-user.ts` assert
DELETE is refused. The migration adds `GRANT DELETE ON replay_sessions, replay_positions TO
forexedge_replay_writer` (additive); those two checks flip to "allowed on replay_*", while DELETE on
`historical_*`, `ticks`, `candles_*` and `instruments` stays refused and tested.

**Q3. Create no longer answers 409.** With several paused sessions allowed, "New replay" while one is in progress
creates a new session. A playing session pauses first (reason USER), and the new session becomes current. The
409 path (`StartForm.onConflict`, fixture `create-409.json`, `replay:e2e`'s "second create is 409") is replaced by
that rule. An alternative is to keep the 409 and require opening/ending from the list first, but that conflicts
with "many paused sessions".

### Answers (2026-11-23)

- Q1 yes: replace the index in the same migration. Rollback check: the old create returns 409 from
  `refuseIfActive` (a query), not only from the index, so after a rollback only two creates at the same instant
  could add an extra unended row. The old `findOne({ userId, status: Not('ENDED') })` has no ORDER BY: with two
  unended rows each request picks one arbitrarily (consistent within a request). Playing a second one while one
  plays is refused by the new one-playing index ("Replay command failed"), so the system fails safe.
  PLAYING is `status = 'PLAYING'` + an in-process timer; boot and clean stop set every PLAYING row to PAUSED
  (SERVER_RESTART), which can only leave the partial index, never violate it.
- Q2 yes: DELETE on the two replay tables only; session and positions in ONE transaction; the existing "DELETE on
  history/ticks/candles/instruments is refused" checks stay. **Future session-owned tables (indicators,
  drawings, ...) must be deleted with the session in the same transaction**: the delete is one function
  (`ReplaySessionService.remove`) with a list of child tables, and a DB test fails if any table has an FK to
  `replay_sessions` that the list doesn't contain (read from `information_schema`).
- Q3 yes: no 409; a create pauses the playing session first. Two concurrent creates while one session plays:
  the one-playing index holds (test: both creates succeed, at most one PLAYING row, which neither new session is).

### Added: every command names its session

Every socket command (`play`, `pause`, `step`, `setSpeed`, `setTimeframe`) carries `{ sessionId }`, and the order
routes move to `POST /replay/sessions/:id/orders`, `/:id/orders/:orderId/cancel`, `/:id/positions/:positionId/close`
and `/:id/end`. The server acts only on that session, read by `(id, user_id)` and `status <> 'ENDED'` under its
lock; it never resolves "the current session" for a write. The `active/orders|cancel|close|end` routes are removed
(the frontend and tools move to the new ones in the same PR; `GET active` stays, read-only).
- `play`, `step`, `setSpeed`, `setTimeframe`, orders, cancels and closes also require the named session to be the
  user's current one; otherwise 409 / `{ ok: false }` "This replay was paused because you opened another one". So
  a stale tab can neither act on the other session (it never names it) nor restart its own behind the user's back.
  `pause` and `end` are allowed on any of the user's unended sessions.
- `open` no longer broadcasts the new session's `state`: the opening tab gets it in the response. The user's
  sockets get `switched { pausedSessionIds, openedSessionId }`; a tab showing a paused session shows the banner
  "This replay was paused because you opened another one" with "Open this replay" (calls `open` for its own
  session). A (re)connecting socket still gets the current session's state.
- Every socket event names its session: `bar`, `calendar`, `endOfData`, `status`/`state` already do; `account`
  and each position get an additive `sessionId` field. The replay slice ignores any event for a session other
  than the one it shows.
- Planted fault: the order route resolves the current session instead of `:id` → the stale-tab DB test (order
  sent for A after B was opened) must fail because the order lands in B.

## 1. Data model (one migration `ReplaySessionsList`, auth-service; entity in `@forexedge/database`)

| Change | Detail |
|---|---|
| `title varchar(60) NULL` | `CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 60)` (Postgres counts characters, as the server does) |
| `last_opened_at timestamptz` | added nullable, **backfilled `= updated_at`** (the last thing that happened to the session), then `SET DEFAULT now()`, `SET NOT NULL` (an old-release insert gets the default) |
| index `replay_sessions_user_last_opened` | `(user_id, last_opened_at DESC, id DESC)`: the list's keyset and "the current session" |
| unique `replay_sessions_one_playing_per_user` | `(user_id) WHERE status = 'PLAYING'` (Q1) |
| grant | `DELETE` on the two replay tables (Q2) |
| drop | `replay_sessions_one_active_per_user` (Q1) |

The title stays NULL when the user gives none; the server sends `displayTitle`. That is the title, or the auto
name `EUR/USD · 1m · 2022-03-16` (pair · timeframe · start date UTC). Decision: the auto name is **stored** when the session is
created without a title and when a rename clears it, so it doesn't drift when the chart's timeframe changes later. The
migration also fills it for existing rows (an UPDATE of NULL titles only). A NULL read (a row an old release created after
a rollback) falls back to the same generator.

## 2. Server (replay-service)

**The current session** = the user's non-ENDED session with the latest `last_opened_at` (ties by id). Every
`active/*` route, every socket command, `connected` and `lastSocketLeft` resolve it through one function
(`findCurrent`). `withSession` re-reads it under the session lock and also checks it is *still* current. A command that
raced an open of another session is refused ("Another replay was opened") instead of playing the old one. An
ENDED session can never be current, so every order/cancel/close/play/step/speed/timeframe on it is refused. The
order service's lock re-read keeps its own `status <> 'ENDED'` check as a second guard.

| Endpoint | Behaviour |
|---|---|
| `GET /replay/sessions?cursor=` | 20 a page, keyset on `(last_opened_at DESC, id DESC)`, opaque cursor (the trades endpoint's encoder). Item: `id, title (displayTitle), instrument, timeframe, status, current, clockTime, netPnlUsd, lastOpenedAt, endedAt`. `netPnlUsd` = balance − starting balance (closed trades; open positions are not marked, labelled so) |
| `PATCH /replay/sessions/:id` `{ title: string \| null }` | any status. Trim, then 1–60 **code points** (`[...s].length`), no control characters (`\p{Cc}`, also rejecting Unicode format controls `\p{Cf}` such as U+202E right-to-left override, which can spoof a title). Empty or null stores the auto name. 400 with the reason. Validated by a DTO through the real `ValidationPipe` **and** the service's `normalizeTitle` |
| `DELETE /replay/sessions/:id` | 204. In one transaction under the session lock: the row `FOR UPDATE` where `id, user_id` and `status = 'ENDED'`, then `DELETE FROM replay_positions WHERE session_id`, then the session. Not ENDED: 409 "End the session before deleting it". Another user's: 404 |
| `POST /replay/sessions/:id/open` | 1) pause every PLAYING session of the user (each under its own lock, timer cancelled, reason USER, `status` event); 2) `last_opened_at = now()` on the target; 3) not ENDED: it is now current. Its full `state` (always PAUSED, never auto-play) goes to the user's sockets and is returned. ENDED: returns its `ReplayState` (chart up to its clock, positions, calendar) **without** a socket event (the socket keeps following the current session) |
| `POST /replay/sessions` | (Q3) pauses a playing session, creates, sets `last_opened_at`, `title` = given or auto; no 409 |

Every new query has `user_id` in its WHERE (another user's id is a 404, never a 403). `assertUserId` comes first.

## 3. Frontend (`apps/frontend`)

- **Landing view** (no session open): "New replay" (StartForm) above **My replays** (`ReplaySessionList`): rows
  with title, pair, timeframe, status, replay time, net P&L, last opened, and "Load more" following `nextCursor`.
- **Status words:** Active = the current session (`current: true`); Paused = another non-ENDED session; Ended.
- **Open:** a paused/active row calls `open`; the socket's `state` replaces the replay slice and the replay
  screen shows. An ended row shows `ReplayEndedView`: chart up to the end, Closed trades and Statistics tabs, and no
  controls, order panel or shortcuts.
- **Rename:** a pencil turns the title into an input. Enter or blur saves, Esc cancels. A server 400 shows its message
  under the input, and the list refetches.
- **Delete:** only on Ended rows; Radix AlertDialog "Delete '<title>'? This can't be undone." (Cancel focused first).
- **My replays** button on the replay screen: pauses if playing, then shows the landing view.
- Titles render as React text only (no `dangerouslySetInnerHTML`); a test renders `<img src=x onerror=…>` as a
  title and finds the literal text.

Frontend decisions, in plain words:
- **The server decides what "current" means; the page only asks.** Two tabs could otherwise disagree about which
  session is open. The page sends "open X" and draws whatever state the server sends back.
- **An ended replay is a separate read-only view, not the live screen with buttons hidden.** The live screen listens
  to the socket. An ended session's data comes from one REST answer and lives in that view only, so no socket event can
  change it, and there is no button that could send a command (the server refuses one anyway).
- **The list is refetched, not patched by hand,** after open, rename, delete, create and end. It is one small request,
  and it avoids keeping two copies of the order in sync.
- **Paging the list like the closed trades** ("Load more", cursor from the server) keeps one pattern for long lists.
- **The delete dialog names the title** so the user sees exactly which replay goes.

## 4. Tests

Backend (DB tests on real minutes, `RUN_DB_TESTS=true`, new `session/sessions-list.db.spec.ts` + updates):
- two paused + one ended session per user coexist; orders on one don't change the other's balance/margin
- list order and paging (21+ sessions over real minutes, cursor boundary, tie on `last_opened_at`), user scope
- rename: 60 code points OK (with an emoji counting 1), 61 refused, trimmed, empty → auto name, `\n`/U+202E refused,
  through the real `ValidationPipe`
- 404 for another user's session on rename / delete / open / list (their sessions never appear)
- delete: PAUSED and PLAYING → 409, row unchanged; ENDED → session and all its positions gone, the user's other
  sessions and their positions untouched (counts compared > 0)
- open B while A plays → A PAUSED (USER), A's timer emits no further bar, B current and PAUSED; the DB unique index
  refuses a second PLAYING row written directly
- an order / play / step after the session ENDED is refused (with another paused session present too)
- migration: `last_opened_at` backfilled from `updated_at`, titles backfilled, `down()` round trip
- grants: DELETE on replay_* allowed, DELETE on `historical_candles` still refused
- unit: `normalizeTitle`, the list cursor
- `replay:verify` unchanged and green (stats/trades to the cent); `replay:e2e` gets the new create/open/delete steps

Frontend (recorded bodies from `record-frontend-fixtures.ts`, sha256 in the manifest): list + Load more, status
words, rename (save / Esc / server 400), delete dialog (only Ended rows, exact text, cancel keeps it), opening an
ended row shows no order panel or controls, a title with markup renders as text.

## 5. Groups (one commit each)

1. Migration + entity (+ grants checks in `create-replay-db-user.ts`, `session.db.spec.ts`).
2. replay-service: current session, `open`, create without 409, one playing. DB suite run once.
3. replay-service: list, rename, delete. DB suite run once.
4. tools: `replay:e2e` steps, fixture recorder (new bodies recorded from a real run).
5. Frontend: API + types, My replays list, rename, delete dialog.
6. Frontend: open/switch, ended read-only view, "My replays" button.
7. Docs: CLAUDE.md replay rules (the one-session rule rewritten), BACKLOG (ended sessions kept on purpose + delete
   → resolved; new: custom indicators in a Pine-like language, own interpreter, no eval), write-up.

Checks per commit: touched projects' lint + typecheck + touched specs. At the end: `npx nx affected -t lint typecheck
test build --base=origin/replay-improvements`, `npm run replay:verify` once.

## 6. Planted faults (each must fail, then pass after revert)

| Fault | Caught by |
|---|---|
| drop `user_id` from the list / rename / delete query | sessions-list DB spec (other user's rows listed / 404 becomes 200/204) |
| allow deleting a PAUSED session | DB spec "paused → 409" |
| title limit 61 | DB spec + `normalizeTitle` unit spec |
| order on an ENDED session (drop the ENDED filter in `findCurrent` and the lock re-read) | DB spec "order after end refused" |
| open B doesn't pause playing A | DB spec "open pauses the playing session" (A still PLAYING / bar events keep coming) |
| delete leaves the session's positions | DB spec "positions gone" (also an FK error: planted as deleting the positions of a different session id) |
