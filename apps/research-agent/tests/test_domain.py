"""Whitelists, the inclusive window and unit suffixes (no database)."""

from __future__ import annotations

from datetime import UTC, date, datetime

import pytest

from research_agent.domain import Coverage, ToolError, check_pair, check_timeframe, unit_of, window

# The coverage of EUR/USD as historical_coverage stores it (2010-01-01 00:00 to 2022-12-30 21:59 UTC)
EUR_USD = Coverage(
    pair="EUR/USD",
    price_decimals=5,
    pip_size="0.0001",
    points_per_pip=10,
    first_time=datetime(2010, 1, 1, tzinfo=UTC),
    last_time=datetime(2022, 12, 30, 21, 59, tzinfo=UTC),
    first_day=date(2010, 1, 1),
    last_day=date(2022, 12, 30),
)


@pytest.mark.parametrize("pair", ["EUR/USD", "GBP/USD", "USD/JPY", "XAU/USD"])
def test_the_four_pairs_pass(pair: str) -> None:
    assert check_pair(pair) == pair


@pytest.mark.parametrize("pair", ["AUD/USD", "EUR/GBP", "BTC/USD"])
def test_another_pair_is_not_in_the_data(pair: str) -> None:
    with pytest.raises(ToolError) as err:
        check_pair(pair)
    assert err.value.code == "OUT_OF_DATA"


@pytest.mark.parametrize("pair", ["EUR_USD", "EURUSD", "eur/usd", "", "EUR/USD; DROP TABLE x"])
def test_a_malformed_pair_is_invalid(pair: str) -> None:
    with pytest.raises(ToolError) as err:
        check_pair(pair)
    assert err.value.code == "INVALID_ARGUMENT"


@pytest.mark.parametrize("tf", ["1m", "5m", "15m", "1w", "", "1h "])
def test_only_1h_4h_1d_are_exposed(tf: str) -> None:
    with pytest.raises(ToolError) as err:
        check_timeframe(tf)
    assert err.value.code == "INVALID_ARGUMENT"


def test_window_is_inclusive_and_holds_whole_bars_only() -> None:
    w = window(EUR_USD, "1d", "2022-03-14", "2022-03-16")
    assert w.start == datetime(2022, 3, 14, tzinfo=UTC)
    # end is 2022-03-17 00:00; the last whole D1 bar starts a day earlier
    assert w.last_bucket == datetime(2022, 3, 16, tzinfo=UTC)
    assert window(EUR_USD, "1h", "2022-03-14", "2022-03-14").last_bucket == datetime(2022, 3, 14, 23, tzinfo=UTC)
    assert window(EUR_USD, "4h", "2022-03-14", "2022-03-14").last_bucket == datetime(2022, 3, 14, 20, tzinfo=UTC)


@pytest.mark.parametrize(
    ("start", "end"),
    [
        ("2009-12-31", "2010-01-05"),
        ("2022-12-30", "2022-12-31"),
        ("2023-01-01", "2023-01-31"),
        ("1999-01-01", "1999-01-02"),
    ],
)
def test_a_range_outside_the_history_is_not_in_the_data(start: str, end: str) -> None:
    with pytest.raises(ToolError) as err:
        window(EUR_USD, "1h", start, end)
    assert err.value.code == "OUT_OF_DATA"


@pytest.mark.parametrize(
    ("start", "end"),
    [("2022-03-16", "2022-03-14"), ("2022-02-30", "2022-03-01"), ("2022-3-1", "2022-03-02"), ("x", "y")],
)
def test_bad_dates_are_invalid(start: str, end: str) -> None:
    with pytest.raises(ToolError) as err:
        window(EUR_USD, "1h", start, end)
    assert err.value.code == "INVALID_ARGUMENT"


@pytest.mark.parametrize(
    ("field", "unit"),
    [
        ("return_pct", "pct"),
        ("high_price", "price"),
        ("avg_spread_pips", "pips"),
        ("total_pnl_usd", "usd"),
        ("bars_count", "count"),
        ("high_time_utc", "utc"),
        ("from_date", "date"),
        ("holm_p", "p"),
        ("p_holm", None),
        ("price_decimals", None),
        ("pair", None),
    ],
)
def test_unit_is_the_field_suffix(field: str, unit: str | None) -> None:
    assert unit_of(field) == unit
