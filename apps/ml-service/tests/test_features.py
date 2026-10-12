"""Features and targets on real H1 bars (tests/fixtures, verbatim database exports)."""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import pytest

from ml_service.data import Bars, read_csv
from ml_service.features import (
    FEATURE_NAMES,
    MIN_TARGET_MINUTES,
    NO_TARGET,
    bar_features,
    next_bar_targets,
    sample_indices,
    windows,
)

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture(scope="module")
def eur() -> Bars:
    return read_csv(FIXTURES / "EURUSD-H1-2022-01.csv", "EUR/USD", pip_points=10)


def csv_rows(name: str) -> list[list[int]]:
    lines = (FIXTURES / name).read_text(encoding="utf-8").splitlines()[1:]
    return [[int(v) for v in line.split(",")] for line in lines if line]


def test_reads_the_fixture_exactly(eur: Bars) -> None:
    rows = csv_rows("EURUSD-H1-2022-01.csv")
    assert len(eur) == len(rows) == 506
    assert eur.time[0] * 1000 == rows[0][0] == 1641160800000  # 2022-01-02 22:00 UTC, the week's first bar
    assert [int(eur.bid_close[5]), int(eur.ask_close[5]), int(eur.minutes[5])] == [rows[5][4], rows[5][8], rows[5][9]]


def test_feature_row_by_hand(eur: Bars) -> None:
    # Bars 0 and 1 (2022-01-02 22:00 and 23:00 UTC, a Sunday), integer points:
    #   bar 0 close: bid 113729, ask 113755 -> 2 x mid 227484
    #   bar 1 open 113721/113756 -> 227477; close 113727/113731 -> 227458;
    #         high 113782/113802 -> 227584; low 113692/113696 -> 227388; 59 minutes
    f = bar_features(eur)[1]
    expected = [
        math.log(227458 / 227484),
        math.log(227458 / 227477),
        math.log(227477 / 227484),
        math.log(227584 / 227388),
        (113731 - 113727) / 10,
        math.log(59 / 60),
        math.sin(2 * math.pi * 23 / 24),
        math.cos(2 * math.pi * 23 / 24),
        math.sin(2 * math.pi * 6 / 7),  # Sunday = 6 (Monday = 0)
        math.cos(2 * math.pi * 6 / 7),
    ]
    assert len(FEATURE_NAMES) == len(expected) == 10
    np.testing.assert_allclose(f, expected, rtol=0, atol=1e-15)


def test_first_row_is_undefined_and_monday_is_weekday_zero(eur: Bars) -> None:
    f = bar_features(eur)
    assert np.isnan(f[0, [0, 2]]).all()  # ret_close and gap need the previous bar
    assert not np.isnan(f[0, [1, 3, 4, 5]]).any()
    monday = int(np.argmax(eur.time >= 1641168000))  # 2022-01-03 00:00 UTC
    assert f[monday, 8] == 0.0 and f[monday, 9] == 1.0


def test_target_is_the_next_bars_open_to_close_direction(eur: Bars) -> None:
    rows = csv_rows("EURUSD-H1-2022-01.csv")
    y = next_bar_targets(eur)
    for t in range(len(rows) - 1):
        nxt = rows[t + 1]
        open2, close2 = nxt[1] + nxt[5], nxt[4] + nxt[8]
        expected = NO_TARGET if close2 == open2 or nxt[9] < MIN_TARGET_MINUTES else int(close2 > open2)
        assert y[t] == expected, t
    assert y[-1] == NO_TARGET  # no next bar


def test_flat_bars_have_no_target_and_are_counted(eur: Bars) -> None:
    y = next_bar_targets(eur)
    flat_times = [1642370400, 1642496400, 1642600800]  # 2022-01-16 22:00, 01-18 09:00, 01-19 14:00
    for ts in flat_times:
        i = int(np.flatnonzero(eur.time == ts)[0])
        assert y[i - 1] == NO_TARGET
    assert [(y == 1).sum(), (y == 0).sum(), (y == NO_TARGET).sum()] == [242, 260, 4]  # 3 flat + the last bar


def test_a_short_target_bar_has_no_target() -> None:
    bars = read_csv(FIXTURES / "EURUSD-H1-2012-12-27-to-2013-01-04.csv", "EUR/USD", pip_points=10)
    i = int(np.flatnonzero(bars.time == 1356991200)[0])  # 2012-12-31 22:00, 16 minutes, closes up
    assert bars.minutes[i] == 16
    assert bars.bid_close[i] + bars.ask_close[i] > bars.bid_open[i] + bars.ask_open[i]
    assert next_bar_targets(bars)[i - 1] == NO_TARGET


def test_no_look_ahead_features_windows_and_targets_ignore_later_bars(eur: Bars) -> None:
    window = 32
    full_f = bar_features(eur)
    full_y = next_bar_targets(eur)
    t_all = sample_indices(len(eur), full_y, window)
    assert len(t_all) > 400
    full_w = windows(full_f, t_all, window)
    for k, t in enumerate(t_all):
        past = eur.slice(0, int(t) + 1)  # bars after t removed
        w = windows(bar_features(past), np.array([t]), window)[0]
        np.testing.assert_array_equal(w, full_w[k])
        # the target needs exactly one bar more, and nothing beyond it
        assert next_bar_targets(eur.slice(0, int(t) + 2))[t] == full_y[t]


def test_sample_indices_need_a_full_defined_window_and_a_target(eur: Bars) -> None:
    y = next_bar_targets(eur)
    t = sample_indices(len(eur), y, 32)
    assert t[0] == 32 and (y[t] != NO_TARGET).all()
    assert len(t) == int((y[32:] != NO_TARGET).sum())
    with pytest.raises(ValueError, match="start before row 1"):
        windows(bar_features(eur), np.array([31]), 32)


def test_usd_jpy_spread_uses_its_pip_points() -> None:
    jpy = read_csv(FIXTURES / "USDJPY-H1-2022-01.csv", "USD/JPY", pip_points=10)
    f = bar_features(jpy)
    np.testing.assert_array_equal(f[:, 4], (jpy.ask_close - jpy.bid_close) / 10)
    assert 0 < np.median(f[:, 4]) < 5


def test_empty_input_fails(eur: Bars, tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="no bars"):
        eur.slice(0, 0)
    with pytest.raises(ValueError, match="no samples"):
        windows(bar_features(eur), np.array([], dtype=np.int64), 32)
    header_only = tmp_path / "header-only.csv"
    header_only.write_text((FIXTURES / "EURUSD-H1-2022-01.csv").read_text(encoding="utf-8").splitlines()[0] + "\n")
    with pytest.raises(ValueError, match="no rows"):
        read_csv(header_only, "EUR/USD", 10)
