"""Walk-forward splits, train-only scaling, metrics and baselines on real H1 bars.

The split tests join two real excerpts (2012-12-27..2013-01-04 and
2015-12-21..2016-01-08) so that the 2016 fold has training, validation and test
targets; only bar times matter there. Nothing is generated."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
from scipy.stats import binomtest

from ml_service import baselines
from ml_service.data import _COLUMNS, Bars, read_csv
from ml_service.features import NO_TARGET, SCALED, bar_features, next_bar_targets, sample_indices
from ml_service.metrics import accuracy, balanced_accuracy, brier, holm, log_loss, mcnemar, wilson_interval
from ml_service.splits import CLIP, FOLDS, Fold, Scaler, fit_scaler, split_samples, year_start

FIXTURES = Path(__file__).parent / "fixtures"


def load(name: str) -> Bars:
    return read_csv(FIXTURES / name, "EUR/USD", pip_points=10)


def joined() -> Bars:
    parts = [load("EURUSD-H1-2012-12-27-to-2013-01-04.csv"), load("EURUSD-H1-2015-12-21-to-2016-01-08.csv")]
    cols = {c: np.concatenate([getattr(p, c) for p in parts]) for c in _COLUMNS}
    return Bars(pair="EUR/USD", pip_points=10, **cols)


def test_seven_expanding_folds_by_year() -> None:
    assert [f.test_year for f in FOLDS] == [2016, 2017, 2018, 2019, 2020, 2021, 2022]
    f = Fold(2016)
    assert f.train == (year_start(2010), year_start(2015))
    assert f.validation == (year_start(2015), year_start(2016))
    assert f.test == (year_start(2016), year_start(2017))
    assert Fold(2022).train == (year_start(2010), year_start(2021))


def test_samples_go_to_the_period_of_their_target_bar() -> None:
    bars = joined()
    y = next_bar_targets(bars)
    t = sample_indices(len(bars), y, 8)
    s = split_samples(t, bars.time, Fold(2016))
    all_t = np.concatenate([s.train, s.validation, s.test])
    assert len(all_t) == len(np.unique(all_t))  # no sample in two periods
    tt = bars.time[s.test + 1]
    vt = bars.time[s.validation + 1]
    assert vt.max() < year_start(2016) <= tt.min()
    assert bars.time[s.train + 1].max() < year_start(2015) <= vt.min()
    # 2015-12-31 21:00 decides the first 2016 bar (2016-01-03 22:00): a test sample
    # whose inputs are all from 2015, the past
    boundary = int(np.flatnonzero(bars.time == 1451595600)[0])
    assert bars.time[boundary + 1] == 1451858400
    assert boundary in s.test


def test_an_empty_period_fails() -> None:
    bars = load("EURUSD-H1-2015-12-21-to-2016-01-08.csv")
    t = sample_indices(len(bars), next_bar_targets(bars), 8)
    with pytest.raises(ValueError, match="the train period has no samples"):
        split_samples(t, bars.time, Fold(2016))
    with pytest.raises(ValueError, match="no samples"):
        split_samples(np.array([], dtype=np.int64), bars.time, Fold(2016))


def test_scaler_uses_only_bars_before_validation() -> None:
    bars = joined()
    f = bar_features(bars)
    fold = Fold(2016)
    scaler = fit_scaler(f, bars.time, fold)
    before = bars.time < fold.validation[0]
    # identical when every validation/test bar is removed
    cut = int(before.sum())
    same = fit_scaler(bar_features(bars.slice(0, cut)), bars.time[:cut], fold)
    np.testing.assert_array_equal(scaler.mean, same.mean)
    np.testing.assert_array_equal(scaler.std, same.std)
    rows = f[before][1:]  # row 0 has undefined features
    assert scaler.fitted_rows == len(rows)
    cols = list(SCALED)
    raw = (rows - scaler.mean) / scaler.std  # standardised before clipping
    np.testing.assert_allclose(raw[:, cols].mean(axis=0), 0, atol=1e-12)
    np.testing.assert_allclose(raw[:, cols].std(axis=0), 1, atol=1e-12)
    z = scaler.transform(rows)
    np.testing.assert_array_equal(z, np.clip(raw, -CLIP, CLIP))
    unscaled = [c for c in range(f.shape[1]) if c not in cols]
    np.testing.assert_array_equal(z[:, unscaled], rows[:, unscaled])
    assert np.abs(scaler.transform(f[~before])).max() <= CLIP
    assert Scaler.from_dict(scaler.to_dict()).to_dict() == scaler.to_dict()


@pytest.fixture(scope="module")
def jan() -> tuple[Bars, np.ndarray, np.ndarray]:
    bars = load("EURUSD-H1-2022-01.csv")
    y = next_bar_targets(bars)
    t = np.flatnonzero(y != NO_TARGET).astype(np.int64)
    return bars, t, y[t]


def test_persistence_and_anti_persistence_by_counting(jan: tuple[Bars, np.ndarray, np.ndarray]) -> None:
    bars, t, y = jan
    rows = [
        [int(v) for v in line.split(",")] for line in (FIXTURES / "EURUSD-H1-2022-01.csv").read_text().splitlines()[1:]
    ]
    y_train = np.array([1, 0, 1], dtype=np.int8)  # majority up -> flat bars fall back to up
    pers = baselines.persistence(bars, t, y_train)
    anti = baselines.anti_persistence(bars, t, y_train)
    for k, i in enumerate(t):
        r = rows[i]
        d = (r[4] + r[8] > r[1] + r[5]) - (r[4] + r[8] < r[1] + r[5])  # this bar's own direction
        assert pers[k] == (1 if d == 0 else int(d > 0))
        assert anti[k] == (1 if d == 0 else int(d < 0))
    hits = int(np.sum(pers == y))
    assert accuracy(y, pers) == hits / len(y)
    assert accuracy(y, anti) + accuracy(y, pers) <= 1 + 1e-12  # they disagree except on flat bars


def test_majority_uses_the_training_targets_only() -> None:
    assert list(baselines.majority(np.array([0, 0, 1], dtype=np.int8), 3)) == [0, 0, 0]
    assert list(baselines.majority(np.array([0, 1], dtype=np.int8), 2)) == [1, 1]  # tie -> up
    with pytest.raises(ValueError):
        baselines.majority(np.array([], dtype=np.int8), 2)


def test_metrics_on_real_targets(jan: tuple[Bars, np.ndarray, np.ndarray]) -> None:
    _, _, y = jan
    up = int(y.sum())
    assert (up, len(y) - up) == (242, 260)
    all_up = np.ones(len(y), dtype=np.int8)
    assert accuracy(y, all_up) == 242 / 502
    assert balanced_accuracy(y, all_up) == 0.5
    p = np.full(len(y), 242 / 502)
    expected = -(242 * np.log(242 / 502) + 260 * np.log(260 / 502)) / 502
    assert log_loss(y, p) == pytest.approx(expected, abs=1e-12)
    assert brier(y, p) == pytest.approx(np.mean((p - y) ** 2), abs=1e-15)


def test_wilson_matches_scipy() -> None:
    lo, hi = wilson_interval(242, 502)
    ci = binomtest(242, 502).proportion_ci(confidence_level=0.95, method="wilson")
    assert (lo, hi) == pytest.approx((ci.low, ci.high), abs=1e-12)


def test_mcnemar_counts_discordant_pairs(jan: tuple[Bars, np.ndarray, np.ndarray]) -> None:
    bars, t, y = jan
    pers = baselines.persistence(bars, t, np.array([1], dtype=np.int8))
    all_up = np.ones(len(y), dtype=np.int8)
    m = mcnemar(y, pers, all_up)
    assert m.a_only == int(np.sum((pers == y) & (all_up != y)))
    assert m.b_only == int(np.sum((pers != y) & (all_up == y)))
    assert m.p_value == pytest.approx(binomtest(m.a_only, m.a_only + m.b_only).pvalue)
    assert mcnemar(y, all_up, all_up).p_value == 1.0  # no discordant pairs


def test_holm() -> None:
    assert holm([0.01, 0.04, 0.03, 0.005]) == pytest.approx([0.03, 0.06, 0.06, 0.02])
    assert holm([0.5]) == [0.5]


def test_metrics_refuse_empty_input() -> None:
    empty = np.array([], dtype=np.int8)
    for fn in (accuracy, balanced_accuracy):
        with pytest.raises(ValueError, match="no samples"):
            fn(empty, empty)
    with pytest.raises(ValueError):
        log_loss(empty, np.array([], dtype=np.float64))
    with pytest.raises(ValueError):
        wilson_interval(0, 0)
    with pytest.raises(ValueError):
        holm([])
