"""Backtest tools: the caller's own COMPLETED runs, with the metrics exactly as stored in
backtest_runs (the trade list is in MinIO and is not read).

Every query is scoped by the caller's user id in the WHERE clause (backtest_runs holds every
user's runs and the DB login is shared), so another user's run is NOT_FOUND, never visible.

Stored metrics and units (apps/ws-gateway/src/backtest/metrics.calculator.ts):
  total_trades      -> total_trades_count   trades closed in the window
  win_rate          -> win_rate_pct         % of trades with net USD > 0, 0-100, 2 dp (null without trades)
  profit_factor     -> profit_factor_ratio  gross profit / gross loss of net USD, 4 dp (null without a loss)
  sharpe_ratio      -> sharpe_ratio         daily NY-close simple returns, mean / sample stdev x sqrt(260), rf 0, 4 dp
  max_drawdown_pct  -> max_drawdown_pct     max (peak - equity) / peak x 100 of the marked-to-market USD equity;
                                            positive (a fall), can exceed 100; 4 dp
  total_pnl         -> total_pnl_pips       net pips after commission, 2 dp
  total_pnl_usd     -> total_pnl_usd        net USD, 2 dp
  final_equity_usd  derived: initial_capital + total_pnl_usd (not stored)
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import psycopg

from research_agent.domain import ToolError, check_pair, iso_utc

STRATEGIES = ("ma_crossover", "london_breakout")
RUN_TIMEFRAMES = ("1m", "5m", "15m", "1h", "4h", "1d")  # the backtest DTO's values
MAX_RUNS = 20

METRIC_NOTES = {
    "win_rate_pct": "percent of trades with a positive net USD result",
    "profit_factor_ratio": "gross profit / gross loss in net USD",
    "sharpe_ratio": "annualised from daily New York-close returns (x sqrt(260), risk-free 0)",
    "max_drawdown_pct": "largest fall of marked-to-market equity from its running peak, in percent (positive)",
    "total_pnl_pips": "net of commission",
    "final_equity_usd": "initial_capital_usd + total_pnl_usd",
}
TRADES_NOTE = "the per-trade list is stored in object storage (MinIO), which the research agent does not read"

Conn = psycopg.Connection[tuple[Any, ...]]

# Granted columns only (migration ResearchReadRole); never minio_object_key or error_message
_COLUMNS = (
    "id, strategy_name, instrument, timeframe, from_date, to_date, parameters, initial_capital, lots, "
    "total_trades, win_rate, profit_factor, sharpe_ratio, max_drawdown_pct, total_pnl, total_pnl_usd, "
    "started_at, completed_at"
)


def _user(user_id: str) -> str:
    """Like assertUserId in @forexedge/common: a missing user id must never widen a query."""
    try:
        return str(uuid.UUID(user_id))
    except (ValueError, TypeError, AttributeError) as err:
        raise RuntimeError("an authenticated user id is required") from err


def _num(v: Decimal | int | None) -> float | int | None:
    if v is None:
        return None
    return int(v) if isinstance(v, int) else float(v)


def _pair(instrument: str) -> str:
    return instrument.replace("_", "/")


def _day(t: datetime) -> str:
    return t.astimezone(UTC).date().isoformat()  # the session time zone must not shift the day


def list_backtest_runs(
    conn: Conn,
    user_id: str,
    pair: str | None = None,
    strategy: str | None = None,
    timeframe: str | None = None,
    limit: int = MAX_RUNS,
) -> dict[str, Any]:
    where = ["user_id = %s", "status = 'COMPLETED'"]
    params: list[Any] = [_user(user_id)]
    if pair is not None:
        where.append("instrument = %s")
        params.append(check_pair(pair).replace("/", "_"))
    if strategy is not None:
        if strategy not in STRATEGIES:
            raise ToolError("INVALID_ARGUMENT", f"strategy must be one of {', '.join(STRATEGIES)}")
        where.append("strategy_name = %s")
        params.append(strategy)
    if timeframe is not None:
        if timeframe not in RUN_TIMEFRAMES:
            raise ToolError("INVALID_ARGUMENT", f"timeframe must be one of {', '.join(RUN_TIMEFRAMES)}")
        where.append("timeframe = %s")
        params.append(timeframe)
    if not 1 <= limit <= MAX_RUNS:
        raise ToolError("INVALID_ARGUMENT", f"limit must be 1 to {MAX_RUNS}")
    params.append(limit)
    rows = conn.execute(
        f"SELECT {_COLUMNS} FROM backtest_runs WHERE {' AND '.join(where)} ORDER BY completed_at DESC, id LIMIT %s",
        params,
    ).fetchall()
    runs = [
        {
            "run_id": str(r[0]),
            "strategy": r[1],
            "pair": _pair(r[2]),
            "timeframe": r[3],
            "from_date": _day(r[4]),
            "to_date": _day(r[5]),
            "total_trades_count": r[9],
            "total_pnl_usd": _num(r[15]),
            "completed_at_utc": iso_utc(r[17]),
        }
        for r in rows
    ]
    out: dict[str, Any] = {"runs": runs, "runs_count": len(runs)}
    if not runs:
        out["note"] = "no completed backtest runs for this user match the filters"
    return out


def get_backtest_run(conn: Conn, user_id: str, run_id: str) -> dict[str, Any]:
    try:
        rid = str(uuid.UUID(run_id))
    except (ValueError, TypeError, AttributeError) as err:
        raise ToolError("INVALID_ARGUMENT", "run_id must be a run id (UUID) from list_backtest_runs") from err
    r = conn.execute(
        f"SELECT {_COLUMNS} FROM backtest_runs WHERE id = %s AND user_id = %s AND status = 'COMPLETED'",
        (rid, _user(user_id)),
    ).fetchone()
    if r is None:
        raise ToolError("NOT_FOUND", "no completed backtest run with that id for this user")
    capital, pnl_usd = r[7], r[15]
    return {
        "run_id": str(r[0]),
        "strategy": r[1],
        "pair": _pair(r[2]),
        "timeframe": r[3],
        "from_date": _day(r[4]),
        "to_date": _day(r[5]),
        "parameters": {f"{k}_param": v for k, v in sorted(r[6].items())},
        "initial_capital_usd": _num(capital),
        "size_lots": _num(r[8]),
        "total_trades_count": r[9],
        "win_rate_pct": _num(r[10]),
        "profit_factor_ratio": _num(r[11]),
        "sharpe_ratio": _num(r[12]),
        "max_drawdown_pct": _num(r[13]),
        "total_pnl_pips": _num(r[14]),
        "total_pnl_usd": _num(pnl_usd),
        "final_equity_usd": None if pnl_usd is None else float(capital + pnl_usd),
        "started_at_utc": iso_utc(r[16]),
        "completed_at_utc": iso_utc(r[17]),
        "metric_notes": METRIC_NOTES,
        "trades_available": False,
        "trades_note": TRADES_NOTE,
    }
