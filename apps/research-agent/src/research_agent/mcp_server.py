"""MCP server (FastMCP, stdio) exposing the read-only research tools.

One server process per /ask request, started by the agent with the caller's identity in its
environment (never in tool arguments, so the model can't see or change it):
  RESEARCH_USER_ID    the authenticated user's id (backtest tools are scoped to it)
  RESEARCH_ML_TOKEN   the caller's access token, forwarded to ml-service unchanged

Each tool returns compact JSON text; a refusal is {"error": {"code", "message"}}. Nothing is
written anywhere: the DB session is read-only and the tools only read."""

from __future__ import annotations

import json
import os
import sys
from collections.abc import Callable
from typing import Any

import httpx
import psycopg
from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations

from research_agent.db import connect
from research_agent.domain import Pair, Timeframe, ToolError
from research_agent.tools import backtests, data, ml

READ_ONLY = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False)


class _Deps:
    """The process's identity and lazily opened connections (one DB session, one HTTP client)."""

    def __init__(self) -> None:
        user_id = os.environ.get("RESEARCH_USER_ID", "").strip()
        token = os.environ.get("RESEARCH_ML_TOKEN", "").strip()
        if not user_id or not token:
            raise SystemExit("RESEARCH_USER_ID and RESEARCH_ML_TOKEN must be set by the agent")
        self.user_id = user_id
        self._token = token
        self._conn: psycopg.Connection[tuple[Any, ...]] | None = None
        self._ml: ml.MlClient | None = None

    def __repr__(self) -> str:
        return "_Deps(user_id=..., token=...)"

    @property
    def conn(self) -> psycopg.Connection[tuple[Any, ...]]:
        if self._conn is None:
            self._conn = connect()
            self._conn.autocommit = True  # read-only session; no transaction left open between calls
        return self._conn

    @property
    def ml(self) -> ml.MlClient:
        if self._ml is None:
            self._ml = ml.MlClient(http=httpx.Client(base_url=ml.ml_base_url(), timeout=30), token=self._token)
        return self._ml


def _run(fn: Callable[[], dict[str, Any]]) -> str:
    try:
        out = fn()
    except ToolError as err:
        out = err.payload()
    except Exception as err:  # never pass driver/connection messages to the model
        print(f"research tool failed: {type(err).__name__}", file=sys.stderr)
        out = ToolError("INTERNAL", "the tool failed; try again later").payload()
    return json.dumps(out, separators=(",", ":"), ensure_ascii=False)


def build_server(deps: _Deps) -> FastMCP:
    server = FastMCP("forexedge-research", log_level="WARNING")

    def tool(fn: Callable[..., str]) -> Callable[..., str]:
        server.tool(annotations=READ_ONLY, structured_output=False)(fn)
        return fn

    @tool
    def list_available_data() -> str:
        """Pairs, timeframes and date ranges in ForexEdge's data (2010-2022 history)."""
        return _run(lambda: data.list_available_data(deps.conn))

    @tool
    def get_bars(pair: Pair, timeframe: Timeframe, from_date: str, to_date: str) -> str:
        """Mid-price bars for an inclusive UTC date range (YYYY-MM-DD), at most 50 rows; for longer
        ranges use get_market_stats."""
        return _run(lambda: data.get_bars(deps.conn, pair, timeframe, from_date, to_date))

    @tool
    def get_market_stats(pair: Pair, timeframe: Timeframe, from_date: str, to_date: str) -> str:
        """Return, up/down bars, high/low, average range and spread, volatility and max drawdown over
        an inclusive UTC date range (YYYY-MM-DD), from mid prices."""
        return _run(lambda: data.get_market_stats(deps.conn, pair, timeframe, from_date, to_date))

    @tool
    def list_backtest_runs(
        pair: Pair | None = None, strategy: str | None = None, timeframe: str | None = None, limit: int = 20
    ) -> str:
        """The user's completed backtest runs (newest first), optionally filtered."""
        return _run(lambda: backtests.list_backtest_runs(deps.conn, deps.user_id, pair, strategy, timeframe, limit))

    @tool
    def get_backtest_run(run_id: str) -> str:
        """One of the user's completed backtest runs: inputs and stored metrics."""
        return _run(lambda: backtests.get_backtest_run(deps.conn, deps.user_id, run_id))

    @tool
    def get_ml_evaluation(pair: Pair) -> str:
        """The LSTM's pooled 2016-2022 out-of-sample evaluation: accuracy, baseline tests (Holm),
        spread break-even and conclusion. Historical test, not signals."""
        return _run(lambda: ml.get_ml_evaluation(deps.ml, pair))

    @tool
    def get_ml_predictions(pair: Pair, year: int, month: int | None = None) -> str:
        """Out-of-sample model results for a test year (2016-2022), or a month's hit-rate summary.
        Historical test, not signals."""
        return _run(lambda: ml.get_ml_predictions(deps.ml, pair, year, month))

    return server


def main() -> None:
    build_server(_Deps()).run("stdio")


if __name__ == "__main__":
    main()
