# Plan: replay statistics

Branch `replay-improvements` (PR #20). Backlog item 3.

## Server (replay-service)

`GET /api/replay/sessions/:id/stats` (owner-scoped like `/trades`: another user's session is a 404).

Computed from **every closed trade of the session** (not a page), read in `(exit_time, id)` order:

| Field | Definition |
|---|---|
| `trades`, `wins`, `losses`, `breakeven` | closed trades; net P&L > 0, < 0, = 0 |
| `winRatePct` | wins / trades × 100, 2 decimals; null with no trades |
| `netPnlUsd` | sum of net P&L (commission included, as booked) |
| `grossProfitUsd` / `grossLossUsd` | sum of winning / losing trades (the loss is negative) |
| `profitFactor` | gross profit / abs(gross loss), 2 decimals; **null when gross loss is 0** (shown "—") |
| `averageWinUsd` / `averageLossUsd` | gross profit / wins, gross loss / losses; null without wins / losses |
| `largestWinUsd` / `largestLossUsd` | best / worst single trade; null without wins / losses |
| `maxDrawdownUsd` / `maxDrawdownPct` | on the **closed-trade balance**: starting balance plus each close in order; the largest fall from a running peak (the peak starts at the starting balance), in USD and as % of that peak (each its own maximum) |

Money is integer cents (BigInt) from the stored `realized_pnl_usd`, returned as decimal strings; every division
rounds half away from zero (as Postgres `round(numeric)` and the backtester's money). An empty session returns
zeros and nulls, never an error. The UI states that the drawdown ignores open positions.

## Independent check (`tools/replay-verify`)

`stats-sql.ts`: the same statistics in one SQL query over `replay_positions` (window functions for the balance and
its peak, `round(numeric, 2)` for every ratio). `npm run replay:verify` already replays the verified backtest
trades (real data: hundreds of trades per pair); after each pair's session it fetches `/stats` and compares every
field to the SQL result as strings (to the cent), writing a table into `docs/validation/replay-equivalence.md` and
exiting 1 on any difference or on zero trades compared. replay-service's DB test uses the same SQL.

## Frontend

A "Statistics" panel (a tab next to Closed trades): RTK Query `getReplayStats`, refetched when a `positions` event
carries a newly closed trade. "—" for null; the drawdown label says "closed-trade balance".

Frontend decisions, in plain words:
- **The server computes, the page only shows**: the numbers must cover every trade, and the page only has some of
  them; computing in two places could disagree.
- **Refetch on a close, not on every bar**: statistics change only when a trade closes, so the page asks again
  exactly then.

## Groups

1. Server: `replay-stats.ts` (pure), endpoint, SQL check module, DB test, replay:verify hook.
2. Frontend: panel, refetch on close, tests (recorded `/stats` bodies).

## Planted faults

- compute from the current page only (first 20 trades) → the SQL comparison (DB test and replay:verify) fails
- off-by-one-cent rounding (round toward zero) → the SQL comparison fails
- profit factor without its zero guard → the empty-session test fails (division by zero)
