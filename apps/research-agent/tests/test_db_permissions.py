"""The research login against the dev database (it can only read, so this is safe).

RUN_DB_TESTS=true npx nx test research-agent
"""

from __future__ import annotations

import os
from collections.abc import Iterator

import psycopg
import pytest
from psycopg import errors

from research_agent.db import connect

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(os.environ.get("RUN_DB_TESTS") != "true", reason="needs RUN_DB_TESTS=true and the dev database"),
]

HISTORY = [
    "historical_candles",
    "historical_candles_1h",
    "historical_candles_4h",
    "historical_candles_1d",
    "historical_price_scale",
    "historical_coverage",
    "instruments",
]

# Migration ResearchReadRole: the granted backtest_runs columns, and nothing else
RUN_COLUMNS = (
    "id, user_id, strategy_name, instrument, timeframe, from_date, to_date, parameters, initial_capital, lots, "
    "status, total_trades, win_rate, profit_factor, sharpe_ratio, max_drawdown_pct, total_pnl, total_pnl_usd, "
    "started_at, completed_at, created_at"
)


@pytest.fixture
def conn() -> Iterator[psycopg.Connection[tuple[object, ...]]]:
    with connect() as c:
        yield c


def test_connects_as_the_research_login_with_a_read_only_session(conn: psycopg.Connection[tuple[object, ...]]) -> None:
    row = conn.execute(
        "SELECT current_user, pg_has_role(current_user, 'forexedge_readonly', 'member'), "
        "pg_has_role(current_user, 'forexedge_research_reader', 'member'), "
        "current_setting('default_transaction_read_only')"
    ).fetchone()
    assert row is not None
    assert row[0] not in (os.environ.get("DB_USER"), os.environ.get("ML_DB_USER"))
    assert row[1:] == (True, True, "on")


def test_reads_the_history_eur_usd_2022_h1_has_6240_bars(conn: psycopg.Connection[tuple[object, ...]]) -> None:
    # 6,240 is the bar count verified in step 3 (docs/validation/backtest-verification.md)
    row = conn.execute(
        "SELECT count(*) FROM historical_candles_1h WHERE pair = 'EUR/USD' "
        "AND bucket >= '2022-01-01T00:00Z' AND bucket < '2022-12-31T00:00Z'"
    ).fetchone()
    assert row == (6240,)


@pytest.mark.parametrize("table", HISTORY)
def test_every_history_table_is_readable(conn: psycopg.Connection[tuple[object, ...]], table: str) -> None:
    row = conn.execute(f"SELECT count(*) > 0 FROM (SELECT 1 FROM {table} LIMIT 1) x").fetchone()
    assert row == (True,)


def test_reads_the_granted_backtest_run_columns(conn: psycopg.Connection[tuple[object, ...]]) -> None:
    # A privilege check, so it doesn't depend on runs existing: the query is allowed and
    # returns exactly the 21 granted columns
    cur = conn.execute(f"SELECT {RUN_COLUMNS} FROM backtest_runs LIMIT 1")
    assert cur.description is not None
    names = [d.name for d in cur.description]
    assert len(names) == 21
    assert names == [c.strip() for c in RUN_COLUMNS.split(",")]


@pytest.mark.parametrize(
    "sql",
    [
        "SELECT minio_object_key FROM backtest_runs LIMIT 1",
        "SELECT error_message FROM backtest_runs LIMIT 1",
        "SELECT progress FROM backtest_runs LIMIT 1",
        "SELECT * FROM backtest_runs LIMIT 1",
        "SELECT 1 FROM users LIMIT 1",
        "SELECT 1 FROM orders LIMIT 1",
        "SELECT 1 FROM positions LIMIT 1",
        "SELECT 1 FROM account_summary LIMIT 1",
    ],
)
def test_everything_else_is_not_readable(conn: psycopg.Connection[tuple[object, ...]], sql: str) -> None:
    with pytest.raises(errors.InsufficientPrivilege):
        conn.execute(sql)


@pytest.mark.parametrize(
    "sql",
    [
        "DELETE FROM historical_candles WHERE false",
        "UPDATE backtest_runs SET status = status WHERE false",
        "INSERT INTO backtest_runs (id) SELECT id FROM backtest_runs WHERE false",
        "DELETE FROM backtest_runs WHERE false",
    ],
)
def test_writes_are_refused(sql: str) -> None:
    # Refused twice over: by privilege, and by the read-only session
    with connect() as c, pytest.raises((errors.InsufficientPrivilege, errors.ReadOnlySqlTransaction)):
        c.execute(sql)


def test_the_read_only_session_refuses_even_a_harmless_write() -> None:
    with connect() as c, pytest.raises(errors.ReadOnlySqlTransaction):
        c.execute("CREATE TEMP TABLE research_probe (x int)")
