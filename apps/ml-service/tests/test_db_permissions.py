"""The read-only login against the dev database (it can only read, so this is safe).

RUN_DB_TESTS=true npx nx test ml-service
"""

from __future__ import annotations

import os
from collections.abc import Iterator

import psycopg
import pytest
from psycopg import errors

from ml_service.db import connect

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(os.environ.get("RUN_DB_TESTS") != "true", reason="needs RUN_DB_TESTS=true and the dev database"),
]

READABLE = [
    "historical_candles",
    "historical_candles_5m",
    "historical_candles_15m",
    "historical_candles_1h",
    "historical_candles_4h",
    "historical_candles_1d",
    "historical_price_scale",
    "historical_coverage",
    "instruments",
]


@pytest.fixture
def conn() -> Iterator[psycopg.Connection[tuple[object, ...]]]:
    with connect() as c:
        yield c


def test_connects_as_the_read_only_login(conn: psycopg.Connection[tuple[object, ...]]) -> None:
    row = conn.execute(
        "SELECT current_user, pg_has_role(current_user, 'forexedge_readonly', 'member'), "
        "current_setting('default_transaction_read_only')"
    ).fetchone()
    assert row is not None
    assert row[0] != os.environ.get("DB_USER")
    assert row[1:] == (True, "on")


def test_reads_the_history_eur_usd_2022_h1_has_6240_bars(conn: psycopg.Connection[tuple[object, ...]]) -> None:
    # 6,240 is the bar count verified in step 3 (docs/validation/backtest-verification.md)
    row = conn.execute(
        "SELECT count(*) FROM historical_candles_1h WHERE pair = 'EUR/USD' "
        "AND bucket >= '2022-01-01T00:00Z' AND bucket < '2022-12-31T00:00Z'"
    ).fetchone()
    assert row == (6240,)


@pytest.mark.parametrize("table", READABLE)
def test_every_granted_table_is_readable(conn: psycopg.Connection[tuple[object, ...]], table: str) -> None:
    row = conn.execute(f"SELECT count(*) > 0 FROM (SELECT 1 FROM {table} LIMIT 1) x").fetchone()
    assert row == (True,)


@pytest.mark.parametrize("table", ["users", "orders", "positions", "account_summary", "backtest_runs"])
def test_other_tables_are_not_readable(conn: psycopg.Connection[tuple[object, ...]], table: str) -> None:
    with pytest.raises(errors.InsufficientPrivilege):
        conn.execute(f"SELECT 1 FROM {table} LIMIT 1")


@pytest.mark.parametrize(
    "sql",
    [
        "DELETE FROM historical_candles WHERE false",
        "UPDATE instruments SET pip_size = pip_size WHERE false",
        "INSERT INTO historical_price_scale SELECT * FROM historical_price_scale WHERE false",
    ],
)
def test_writes_are_refused(sql: str) -> None:
    # Both layers refuse: the read-only session, and (with it switched off) the role
    with connect() as c, pytest.raises(errors.ReadOnlySqlTransaction):
        c.execute(sql)
    with connect() as c:
        c.execute("SET default_transaction_read_only = off")
        c.commit()
        with pytest.raises(errors.InsufficientPrivilege):
            c.execute(sql)
