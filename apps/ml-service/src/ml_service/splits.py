"""Walk-forward splits by time and train-only feature scaling.

Expanding window, one fold per test year (7 per pair):

  test year Y   train targets 2010-01-01 .. Y-1 Jan 1   validation targets year Y-1   test targets year Y

A sample belongs to the period that contains its TARGET bar (bar t+1). Its inputs
(the window ending at t) may lie in an earlier period: that is the past, never the
future. Validation is used only for early stopping and model selection; the test
year is scored once at the end.

Scaling: per-feature mean and standard deviation from the feature rows of bars that
start before the validation period (the information available when training ends),
applied unchanged to validation, test and inference; scaled values clipped at +-10.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime

import numpy as np
import numpy.typing as npt

from ml_service.features import N_FEATURES, SCALED

F64 = npt.NDArray[np.float64]
I64 = npt.NDArray[np.int64]
BoolArr = npt.NDArray[np.bool_]

FIRST_YEAR = 2010
TEST_YEARS = tuple(range(2016, 2023))
CLIP = 10.0


def year_start(year: int) -> int:
    return int(datetime(year, 1, 1, tzinfo=UTC).timestamp())


@dataclass(frozen=True)
class Fold:
    test_year: int

    @property
    def train(self) -> tuple[int, int]:
        return year_start(FIRST_YEAR), year_start(self.test_year - 1)

    @property
    def validation(self) -> tuple[int, int]:
        return year_start(self.test_year - 1), year_start(self.test_year)

    @property
    def test(self) -> tuple[int, int]:
        return year_start(self.test_year), year_start(self.test_year + 1)

    @property
    def name(self) -> str:
        return f"test{self.test_year}"


FOLDS = tuple(Fold(y) for y in TEST_YEARS)


@dataclass(frozen=True)
class SplitIndices:
    train: I64
    validation: I64
    test: I64


def split_samples(sample_t: I64, bar_time: I64, fold: Fold) -> SplitIndices:
    """Splits decision bars t by their target bar's start time (bar t+1)."""
    if len(sample_t) == 0:
        raise ValueError("no samples")
    target_time = bar_time[sample_t + 1]

    def within(period: tuple[int, int]) -> I64:
        lo, hi = period
        picked: I64 = sample_t[(target_time >= lo) & (target_time < hi)]
        return picked

    out = SplitIndices(within(fold.train), within(fold.validation), within(fold.test))
    for name in ("train", "validation", "test"):
        if len(getattr(out, name)) == 0:
            raise ValueError(f"{fold.name}: the {name} period has no samples")
    return out


@dataclass(frozen=True)
class Scaler:
    mean: F64  # (N_FEATURES,), 0 for unscaled columns
    std: F64  # (N_FEATURES,), 1 for unscaled columns
    fitted_rows: int

    def transform(self, x: F64) -> F64:
        out: F64 = (x - self.mean) / self.std
        np.clip(out, -CLIP, CLIP, out=out)
        return out

    def to_dict(self) -> dict[str, object]:
        return {"mean": self.mean.tolist(), "std": self.std.tolist(), "fitted_rows": self.fitted_rows}

    @staticmethod
    def from_dict(d: dict[str, object]) -> Scaler:
        mean = np.asarray(d["mean"], dtype=np.float64)
        std = np.asarray(d["std"], dtype=np.float64)
        rows = d["fitted_rows"]
        if mean.shape != (N_FEATURES,) or std.shape != (N_FEATURES,) or not isinstance(rows, int):
            raise ValueError("scaler shape mismatch")
        return Scaler(mean, std, rows)


def fit_scaler(features: F64, bar_time: I64, fold: Fold) -> Scaler:
    """Statistics from rows of bars that start before the validation period."""
    rows = features[bar_time < fold.validation[0]]
    rows = rows[~np.isnan(rows).any(axis=1)]
    if len(rows) == 0:
        raise ValueError(f"{fold.name}: no rows to fit the scaler")
    mean = np.zeros(N_FEATURES)
    std = np.ones(N_FEATURES)
    cols = list(SCALED)
    mean[cols] = rows[:, cols].mean(axis=0)
    sd = rows[:, cols].std(axis=0)
    if np.any(sd <= 0):
        raise ValueError(f"{fold.name}: a scaled feature is constant in the training rows")
    std[cols] = sd
    return Scaler(mean, std, len(rows))
