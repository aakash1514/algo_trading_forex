"""Naive baselines, scored on exactly the LSTM's test samples.

  majority          the direction more common among the fold's training targets
                    (ties -> up); probability = the training up-rate (for log loss)
  persistence       bar t+1 moves like bar t (open -> close); a flat bar t falls back
                    to the majority direction
  anti_persistence  the opposite of bar t; a flat bar t falls back to the majority
The fourth baseline, logistic regression on the same window, is trained with the
LSTM's code (ml_service.training).
"""

from __future__ import annotations

import numpy as np
import numpy.typing as npt

from ml_service.data import Bars

I8 = npt.NDArray[np.int8]
I64 = npt.NDArray[np.int64]


def training_up_rate(y_train: I8) -> float:
    if len(y_train) == 0:
        raise ValueError("no training targets")
    return float(np.mean(y_train))


def majority(y_train: I8, n: int) -> I8:
    up = training_up_rate(y_train) >= 0.5
    return np.full(n, 1 if up else 0, dtype=np.int8)


def bar_direction(bars: Bars, t: I64) -> I8:
    """1 up, 0 down, -1 flat: bar t's own mid open -> close."""
    if len(t) == 0:
        raise ValueError("no samples")
    close2 = bars.bid_close[t] + bars.ask_close[t]
    open2 = bars.bid_open[t] + bars.ask_open[t]
    out: I8 = np.where(close2 == open2, -1, (close2 > open2).astype(np.int8)).astype(np.int8)
    return out


def persistence(bars: Bars, t: I64, y_train: I8) -> I8:
    d = bar_direction(bars, t)
    fallback = majority(y_train, 1)[0]
    out: I8 = np.where(d == -1, fallback, d).astype(np.int8)
    return out


def anti_persistence(bars: Bars, t: I64, y_train: I8) -> I8:
    d = bar_direction(bars, t)
    fallback = majority(y_train, 1)[0]
    out: I8 = np.where(d == -1, fallback, 1 - d).astype(np.int8)
    return out
