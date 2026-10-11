"""Features and the next-bar target, with no look-ahead.

Decision time is the close of H1 bar t. A sample is (window of the last W bars'
features ending at t, target of bar t+1):

  target y[t]  1 if bar t+1 closes above its open (mid), 0 if below, in points:
               bid_close + ask_close  vs  bid_open + ask_open  (2 x mid, exact).
               NO_TARGET when they are equal (flat), when bar t+1 holds fewer than
               MIN_TARGET_MINUTES minutes, or when t is the last bar.
               Open-to-close of the next bar is the move a trade gets when it fills
               at that bar's open (as the backtester does); it ignores the gap from
               bar t's close, so a weekend sits outside the target.

  feature row i uses bar i and bar i-1 only (row 0 is partly undefined: no previous bar),
  so a window ending at t sees nothing after t.
"""

from __future__ import annotations

import numpy as np
import numpy.typing as npt

from ml_service.data import Bars

F64 = npt.NDArray[np.float64]
I8 = npt.NDArray[np.int8]
I64 = npt.NDArray[np.int64]

NO_TARGET = -1
MIN_TARGET_MINUTES = 30

FEATURE_NAMES = (
    "ret_close",  # log(mid_close_i / mid_close_{i-1})
    "ret_open_close",  # log(mid_close_i / mid_open_i)
    "gap",  # log(mid_open_i / mid_close_{i-1})
    "range",  # log(mid_high_i / mid_low_i), mid high = (bid_high + ask_high) / 2
    "spread_pips",  # (ask_close - bid_close) / pip points
    "log_minutes",  # log(minutes / 60)
    "hour_sin",
    "hour_cos",
    "weekday_sin",
    "weekday_cos",
)
N_FEATURES = len(FEATURE_NAMES)
# Columns standardised with training statistics (the time encodings are not)
SCALED = tuple(range(6))


def bar_features(bars: Bars) -> F64:
    """(n, N_FEATURES); row 0 is NaN in the columns that need the previous bar."""
    close2 = (bars.bid_close + bars.ask_close).astype(np.float64)  # 2 x mid, exact in float64
    open2 = (bars.bid_open + bars.ask_open).astype(np.float64)
    high2 = (bars.bid_high + bars.ask_high).astype(np.float64)
    low2 = (bars.bid_low + bars.ask_low).astype(np.float64)
    prev_close2 = np.concatenate(([np.nan], close2[:-1]))

    hours = (bars.time // 3600) % 24
    weekday = ((bars.time // 86400) + 3) % 7  # 1970-01-01 was a Thursday; Monday = 0
    out = np.empty((len(bars), N_FEATURES), dtype=np.float64)
    out[:, 0] = np.log(close2 / prev_close2)
    out[:, 1] = np.log(close2 / open2)
    out[:, 2] = np.log(open2 / prev_close2)
    out[:, 3] = np.log(high2 / low2)
    out[:, 4] = (bars.ask_close - bars.bid_close) / bars.pip_points
    out[:, 5] = np.log(bars.minutes / 60.0)
    out[:, 6] = np.sin(2 * np.pi * hours / 24)
    out[:, 7] = np.cos(2 * np.pi * hours / 24)
    out[:, 8] = np.sin(2 * np.pi * weekday / 7)
    out[:, 9] = np.cos(2 * np.pi * weekday / 7)
    return out


def next_bar_targets(bars: Bars) -> I8:
    """y[t] for the bar after t (see module docstring); NO_TARGET where undefined."""
    y = np.full(len(bars), NO_TARGET, dtype=np.int8)
    close2 = bars.bid_close[1:] + bars.ask_close[1:]
    open2 = bars.bid_open[1:] + bars.ask_open[1:]
    full = bars.minutes[1:] >= MIN_TARGET_MINUTES
    y[:-1] = np.where(~full | (close2 == open2), NO_TARGET, (close2 > open2).astype(np.int8))
    return y


def sample_indices(n_bars: int, targets: I8, window: int) -> I64:
    """Decision bars t with a full window of defined features (t - window + 1 >= 1,
    since feature row 0 is undefined) and a defined target."""
    if window < 1:
        raise ValueError("window must be >= 1")
    if len(targets) != n_bars:
        raise ValueError("targets length differs from the bar count")
    t = np.arange(window, n_bars, dtype=np.int64)
    kept: I64 = t[targets[t] != NO_TARGET]
    return kept


def windows(features: F64, t: I64, window: int) -> F64:
    """(len(t), window, N_FEATURES): rows t-window+1 .. t for each t (a view, no copy)."""
    if len(t) == 0:
        raise ValueError("no samples")
    if t.min() < window or t.max() >= len(features):
        raise ValueError("a window would start before row 1 or end past the last bar")
    view = np.lib.stride_tricks.sliding_window_view(features, window, axis=0)  # (n-w+1, F, w)
    out: F64 = view[t - window + 1].transpose(0, 2, 1)
    if np.isnan(out).any():
        raise ValueError("a window contains undefined features")
    return out
