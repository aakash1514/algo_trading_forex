# Plan: paged closed-trade history

Branch `replay-improvements` (PR #20). Backlog item 4.

## Today

The socket's `state` carries the pending/open positions plus the latest 50 closed or cancelled entries
(`RECENT_CLOSED`), so the Closed trades tab lists those only.

## Server (replay-service)

`GET /api/replay/sessions/:id/trades[?cursor=<opaque>]` → `{ trades: PositionView[], nextCursor: string | null }`

- **Closed trades only** (`status = 'CLOSED'`; a cancelled order is not a trade), newest first, **20 per page**.
- **Keyset paging on (exit_time DESC, id DESC)**: the cursor is the last row's `(exit_time, id)` and the next page
  is `WHERE (exit_time, id) < (cursor)`. Several trades often close in the same replay minute (a session end closes
  every open position at one minute; SL/TP exits share a minute), so `id` breaks the tie; without it rows with equal
  times would come back in any order and a page boundary inside them would repeat or skip rows. A trade that closes
  while the user scrolls has a later `exit_time` than every loaded row (the replay clock only moves forward), so it
  can only ever land above page 1, never inside a later page. Offset paging would shift every later page by one.
- The cursor is base64url JSON `{ t, id }`, validated strictly (anything else is a 400).
- **Owner scope** in the query itself: `JOIN replay_sessions s ON s.id = p.session_id AND s.user_id = :userId`, and the
  session is looked up as `{ id, userId }` first: another user's session (or none) is a 404, never a 403
  (CLAUDE.md "Authorization"). `:id` goes through `ParseUUIDPipe`.
- Works for an ended session too (the history is read only).
- **Index** (migration `ReplayClosedTradesIndex`, additive): `replay_positions (session_id, exit_time DESC, id DESC)
  WHERE status = 'CLOSED'`, the exact order of the keyset query. Nothing is dropped or renamed.

## Frontend

- `getReplayTrades` (RTK Query, infinite list kept in the component): page 1 on opening the tab, **Load more** with
  the `nextCursor`, the button hidden when it is null.
- New closes arrive by socket (`positions`); the tab merges them **by id** with the loaded pages and sorts by
  `(exitTime desc, id desc)`, so a new close goes to the top and never duplicates a loaded row.

Frontend decisions, in plain words:
- **The loaded pages live in the component, not the shared store**: only this tab uses them, and leaving the page
  should forget them.
- **Merge by id, then sort**: the socket and the server can both send the same trade; keeping one entry per id makes
  that harmless, and sorting with the server's own order keeps the list identical to a fresh load.

## Groups

1. Server: migration, endpoint, service, DB tests.
2. Frontend: Load more, merge with socket closes, tests (recorded `/trades` bodies).

## Tests (server, real minutes)

- 25 trades closed in the same minute + 1 later: pages of 20 then 5 (+1 on top), every trade once, order
  `(exit_time desc, id desc)`, `nextCursor` null on the last page
- a trade closing between page 1 and page 2 doesn't change page 2
- another user's session id → 404; a malformed cursor → 400; an unknown session → 404

## Planted faults

- ORDER BY exit_time only (no id tie-break) → the equal-time paging test fails
- drop the user scope → the other-user 404 test fails
