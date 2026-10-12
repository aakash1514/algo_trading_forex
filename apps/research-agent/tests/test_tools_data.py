"""Market data tools vs an independent SQL reproduction (sql/stats_check.sql), on the dev
database through the read-only research login.

RUN_DB_TESTS=true npx nx test research-agent
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import psycopg
import pytest

from research_agent.config import SERVICE_ROOT
from research_agent.db import connect
from research_agent.domain import BAR, PAIRS, TABLES, ToolError, iso_utc
from research_agent.tools.data import MAX_BARS, get_bars, get_market_stats, list_available_data

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(os.environ.get("RUN_DB_TESTS") != "true", reason="needs RUN_DB_TESTS=true and the dev database"),
]

STATS_SQL = (SERVICE_ROOT / "sql" / "stats_check.sql").read_text(encoding="utf-8")
DECIMALS = {"EUR/USD": 5, "GBP/USD": 5, "USD/JPY": 3, "XAU/USD": 3}

# One window per timeframe, for every pair: a US DST switch (Sunday 2022-03-13) inside the 1h
# window, a whole year of 4h bars, and the entire history in 1d bars
WINDOWS = {"1h": ("2022-03-07", "2022-03-18"), "4h": ("2021-01-01", "2021-12-31"), "1d": ("2010-01-01", "2022-12-30")}
CASES = [(p, tf, *WINDOWS[tf]) for p in PAIRS for tf in ("1h", "4h", "1d")]

Conn = psycopg.Connection[tuple[Any, ...]]


@pytest.fixture(scope="module")
def conn() -> Iterator[Conn]:
    with connect() as c:
        yield c


def sql_stats(conn: Conn, pair: str, tf: str, start: str, end: str) -> dict[str, Any]:
    first = datetime.fromisoformat(start).replace(tzinfo=UTC)
    last = datetime.fromisoformat(end).replace(tzinfo=UTC) + BAR["1d"] - BAR[tf]
    cur = conn.execute(STATS_SQL.format(table=TABLES[tf]), {"pair": pair, "start": first, "last": last})
    row = cur.fetchone()
    assert row is not None and cur.description is not None
    return dict(zip([d.name for d in cur.description], row, strict=True))


def price(points2: Decimal, pair: str) -> float:
    return float(points2 / 2 / Decimal(10) ** DECIMALS[pair])


@pytest.mark.parametrize(("pair", "tf", "start", "end"), CASES)
def test_market_stats_equal_the_independent_sql(conn: Conn, pair: str, tf: str, start: str, end: str) -> None:
    tool = get_market_stats(conn, pair, tf, start, end)
    sql = sql_stats(conn, pair, tf, start, end)
    assert sql["bars"] > 0 and tool["bars_count"] == sql["bars"]
    assert tool["first_bar_utc"] == iso_utc(sql["first_bucket"])
    assert tool["last_bar_utc"] == iso_utc(sql["last_bucket"])
    # Exact: prices, counts, times
    assert tool["first_open_price"] == price(sql["first_o2"], pair)
    assert tool["last_close_price"] == price(sql["last_c2"], pair)
    assert tool["high_price"] == price(sql["high_h2"], pair)
    assert tool["high_time_utc"] == iso_utc(sql["high_bucket"])
    assert tool["low_price"] == price(sql["low_l2"], pair)
    assert tool["low_time_utc"] == iso_utc(sql["low_bucket"])
    assert (tool["up_bars_count"], tool["down_bars_count"], tool["flat_bars_count"]) == (
        sql["up_bars"],
        sql["down_bars"],
        sql["flat_bars"],
    )
    assert tool["up_bars_count"] + tool["down_bars_count"] + tool["flat_bars_count"] == tool["bars_count"]
    # Derived values: the tool rounds to 6 decimals; numeric SQL is the reference
    pip_points = 10  # 0.0001 at 5 decimals, 0.01 at 3 decimals (instruments x historical_price_scale)
    tol = Decimal("0.000001")
    assert abs(Decimal(str(tool["return_pct"])) - sql["return_pct"]) <= tol
    assert abs(Decimal(str(tool["avg_range_pips"])) - sql["avg_range_points"] / pip_points) <= tol
    assert abs(Decimal(str(tool["avg_spread_pips"])) - sql["avg_spread_points"] / pip_points) <= tol
    assert abs(Decimal(str(tool["realized_vol_per_bar_pct"])) - sql["vol_per_bar_pct"]) <= tol
    assert abs(Decimal(str(tool["max_drawdown_pct"])) - sql["max_drawdown_pct"]) <= tol
    assert tool["max_drawdown_pct"] >= 0
    if tf == "1d":
        annual = sql["vol_per_bar_pct"] * Decimal(260).sqrt()
        assert abs(Decimal(str(tool["realized_vol_annualized_pct"])) - annual) <= Decimal("0.00001")
    else:
        assert tool["realized_vol_annualized_pct"] is None


def test_d1_window_monday_to_wednesday_holds_only_whole_bars(conn: Conn) -> None:
    # The NY-aligned D1 bar starting Sunday 21:00 UTC begins before From, and the one starting
    # Wednesday 21:00 UTC ends after To: only the Monday and Tuesday evening bars are whole
    tool = get_market_stats(conn, "EUR/USD", "1d", "2022-03-14", "2022-03-16")
    assert tool["bars_count"] == 2
    assert (tool["first_bar_utc"], tool["last_bar_utc"]) == ("2022-03-14T21:00:00Z", "2022-03-15T21:00:00Z")
    assert tool["realized_vol_per_bar_pct"] is None  # one return only


def test_bars_equal_the_raw_rows(conn: Conn) -> None:
    tool = get_bars(conn, "USD/JPY", "1d", "2022-03-01", "2022-03-31")
    rows = conn.execute(
        "SELECT bucket, bid_open + ask_open, bid_high + ask_high, bid_low + ask_low, bid_close + ask_close, "
        "ask_close - bid_close FROM historical_candles_1d WHERE pair = 'USD/JPY' "
        "AND bucket >= '2022-03-01T00:00Z' AND bucket <= '2022-03-31T00:00Z' ORDER BY bucket"
    ).fetchall()
    assert len(rows) > 0 and len(tool["rows"]) == len(rows)
    assert tool["columns"] == ["time_utc", "open_price", "high_price", "low_price", "close_price", "close_spread_pips"]
    for got, r in zip(tool["rows"], rows, strict=True):
        assert got == [iso_utc(r[0]), *(int(x) / 2 / 1000 for x in r[1:5]), int(r[5]) / 10]


def test_bars_over_the_cap_are_refused_with_advice(conn: Conn) -> None:
    with pytest.raises(ToolError) as err:
        get_bars(conn, "EUR/USD", "1h", "2022-03-07", "2022-03-11")
    assert err.value.code == "TOO_MANY_ROWS"
    assert f"at most {MAX_BARS}" in err.value.message and "get_market_stats" in err.value.message


@pytest.mark.parametrize("tool", [get_bars, get_market_stats])
def test_a_window_without_bars_is_an_error_never_zeros(conn: Conn, tool: Any) -> None:
    with pytest.raises(ToolError) as err:
        tool(conn, "EUR/USD", "1h", "2022-01-08", "2022-01-08")  # a Saturday
    assert err.value.code == "NO_BARS"


@pytest.mark.parametrize(
    ("args", "code"),
    [
        (("AUD/USD", "1h", "2022-01-03", "2022-01-04"), "OUT_OF_DATA"),
        (("EUR/USD", "1h", "2023-01-02", "2023-01-03"), "OUT_OF_DATA"),
        (("EUR/USD", "15m", "2022-01-03", "2022-01-04"), "INVALID_ARGUMENT"),
        (("EUR_USD", "1h", "2022-01-03", "2022-01-04"), "INVALID_ARGUMENT"),
    ],
)
def test_refusals(conn: Conn, args: tuple[str, str, str, str], code: str) -> None:
    for tool in (get_bars, get_market_stats):
        with pytest.raises(ToolError) as err:
            tool(conn, *args)
        assert err.value.code == code


def test_available_data_equals_the_coverage_table(conn: Conn) -> None:
    tool = list_available_data(conn)
    rows = conn.execute(
        "SELECT c.pair, c.first_time, c.last_time, c.price_decimals, "
        "(SELECT count(*) FROM historical_candles_1h h WHERE h.pair = c.pair) "
        "FROM historical_coverage c ORDER BY c.pair"
    ).fetchall()
    assert len(rows) == 4 and len(tool["pairs"]) == 4
    by_pair = {p["pair"]: p for p in tool["pairs"]}
    for pair, first, last, decimals, h1 in rows:
        p = by_pair[pair]
        assert (p["first_bar_utc"], p["last_bar_utc"]) == (iso_utc(first), iso_utc(last))
        assert p["price_decimals"] == decimals and p["h1_bars_count"] == h1 > 0
        assert p["timeframes"] == ["1h", "4h", "1d"]
