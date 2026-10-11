"""read_bars against the dev database as the read-only login (RUN_DB_TESTS=true)."""

from __future__ import annotations

import os
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import psycopg
import pytest

from ml_service.data import _COLUMNS, pip_points, read_bars, read_csv
from ml_service.db import connect

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(os.environ.get("RUN_DB_TESTS") != "true", reason="needs RUN_DB_TESTS=true and the dev database"),
]

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture
def conn() -> Iterator[psycopg.Connection[tuple[object, ...]]]:
    with connect() as c:
        yield c


@pytest.mark.parametrize(
    ("name", "pair", "start", "end"),
    [
        ("EURUSD-H1-2022-01.csv", "EUR/USD", "2022-01-01", "2022-02-01"),
        ("USDJPY-H1-2022-01.csv", "USD/JPY", "2022-01-01", "2022-02-01"),
    ],
)
def test_read_bars_equals_the_fixture_exported_from_the_same_rows(
    conn: psycopg.Connection[tuple[object, ...]], name: str, pair: str, start: str, end: str
) -> None:
    db = read_bars(
        conn, pair, datetime.fromisoformat(start).replace(tzinfo=UTC), datetime.fromisoformat(end).replace(tzinfo=UTC)
    )
    fx = read_csv(FIXTURES / name, pair, pip_points=10)
    assert len(db) == len(fx) == 506
    for col in _COLUMNS:
        np.testing.assert_array_equal(getattr(db, col), getattr(fx, col), err_msg=col)


@pytest.mark.parametrize("pair", ["EUR/USD", "GBP/USD", "USD/JPY", "XAU/USD"])
def test_pip_is_ten_points_for_every_pair(conn: psycopg.Connection[tuple[object, ...]], pair: str) -> None:
    assert pip_points(conn, pair) == 10


def test_an_empty_range_fails(conn: psycopg.Connection[tuple[object, ...]]) -> None:
    # Saturday 2022-01-01: no bars
    with pytest.raises(ValueError, match="no H1 bars"):
        read_bars(conn, "EUR/USD", datetime(2022, 1, 1, tzinfo=UTC), datetime(2022, 1, 2, tzinfo=UTC))
