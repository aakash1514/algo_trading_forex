"""Classification metrics and the significance tests fixed before training.

Rule (pre-registered in the step-4 plan, Holm added on review): the LSTM beats a
baseline only if its pooled 2016-2022 accuracy is higher AND the pooled McNemar test
(exact binomial on the discordant pairs) is significant at 0.05 after a Holm
correction across all pooled LSTM-vs-baseline tests (4 pairs x 4 baselines = 16).
Raw and adjusted p-values are both reported. Every function refuses empty input.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import numpy.typing as npt
from scipy.stats import binomtest

I8 = npt.NDArray[np.int8]
F64 = npt.NDArray[np.float64]

ALPHA = 0.05
EPS = 1e-7


def _check(y: I8, other: npt.NDArray[np.generic]) -> None:
    if len(y) == 0:
        raise ValueError("no samples")
    if len(other) != len(y):
        raise ValueError("length mismatch")
    if not np.isin(y, (0, 1)).all():
        raise ValueError("labels must be 0/1")


def accuracy(y: I8, pred: I8) -> float:
    _check(y, pred)
    return float(np.mean(y == pred))


def balanced_accuracy(y: I8, pred: I8) -> float:
    """Mean of the recall of each class; needs both classes present."""
    _check(y, pred)
    recalls = []
    for c in (0, 1):
        n = int(np.sum(y == c))
        if n == 0:
            raise ValueError(f"class {c} is absent")
        recalls.append(float(np.sum((y == c) & (pred == c))) / n)
    return sum(recalls) / 2


def log_loss(y: I8, p_up: F64) -> float:
    _check(y, p_up)
    p = np.clip(p_up, EPS, 1 - EPS)
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))


def brier(y: I8, p_up: F64) -> float:
    _check(y, p_up)
    return float(np.mean((p_up - y) ** 2))


def wilson_interval(successes: int, n: int, z: float = 1.959963984540054) -> tuple[float, float]:
    """95% Wilson score interval for a proportion."""
    if n <= 0:
        raise ValueError("no samples")
    if not 0 <= successes <= n:
        raise ValueError("successes out of range")
    p = successes / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return centre - half, centre + half


@dataclass(frozen=True)
class McNemar:
    a_only: int  # model A right, B wrong
    b_only: int
    p_value: float  # two-sided exact binomial on the discordant pairs


def mcnemar(y: I8, pred_a: I8, pred_b: I8) -> McNemar:
    _check(y, pred_a)
    _check(y, pred_b)
    right_a = pred_a == y
    right_b = pred_b == y
    a_only = int(np.sum(right_a & ~right_b))
    b_only = int(np.sum(~right_a & right_b))
    discordant = a_only + b_only
    p = 1.0 if discordant == 0 else float(binomtest(a_only, discordant, 0.5, alternative="two-sided").pvalue)
    return McNemar(a_only, b_only, p)


def holm(p_values: list[float]) -> list[float]:
    """Holm-Bonferroni adjusted p-values (same order as given)."""
    m = len(p_values)
    if m == 0:
        raise ValueError("no p-values")
    order = sorted(range(m), key=lambda i: p_values[i])
    adjusted = [0.0] * m
    running = 0.0
    for rank, i in enumerate(order):
        running = max(running, min(1.0, (m - rank) * p_values[i]))
        adjusted[i] = running
    return adjusted
