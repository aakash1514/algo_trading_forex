"""Offline training (never run by the service).

Adam (lr 1e-3), batches of 512, BCE on the logit, at most 40 epochs, early stopping on
validation log loss with patience 5, and the best epoch's weights restored. Runs are
reproducible: fixed seeds, deterministic algorithms, a fixed thread count, and batches
drawn from a seeded generator.
"""

from __future__ import annotations

import copy
import math
import time
from dataclasses import dataclass, field

import numpy as np
import numpy.typing as npt
import torch
from torch import nn

from ml_service.model import ModelConfig, build

F64 = npt.NDArray[np.float64]
F32 = npt.NDArray[np.float32]
I8 = npt.NDArray[np.int8]
I64 = npt.NDArray[np.int64]

LEARNING_RATE = 1e-3
BATCH_SIZE = 512
MAX_EPOCHS = 40
PATIENCE = 5
PREDICT_BATCH = 4096


@dataclass(frozen=True)
class TrainSettings:
    seed: int = 20261011
    threads: int = 8
    max_epochs: int = MAX_EPOCHS
    patience: int = PATIENCE
    batch_size: int = BATCH_SIZE


DEFAULT_SETTINGS = TrainSettings()


@dataclass
class TrainResult:
    model: nn.Module
    best_epoch: int
    best_val_loss: float
    history: list[dict[str, float]] = field(default_factory=list)
    seconds: float = 0.0


def set_determinism(settings: TrainSettings) -> None:
    torch.manual_seed(settings.seed)
    torch.use_deterministic_algorithms(True)
    torch.set_num_threads(settings.threads)


def batch_windows(scaled: F32, t: I64, window: int) -> torch.Tensor:
    """(len(t), window, features): rows t-window+1..t of the scaled feature matrix."""
    if len(t) == 0:
        raise ValueError("no samples")
    if t.min() < window or t.max() >= len(scaled):
        raise ValueError("a window would start before row 1 or end past the last bar")
    idx = t[:, None] + np.arange(-window + 1, 1, dtype=np.int64)[None, :]
    return torch.from_numpy(np.ascontiguousarray(scaled[idx]))


def predict_proba(model: nn.Module, scaled: F32, t: I64, window: int) -> F64:
    model.eval()
    out = []
    with torch.no_grad():
        for start in range(0, len(t), PREDICT_BATCH):
            chunk = t[start : start + PREDICT_BATCH]
            out.append(torch.sigmoid(model(batch_windows(scaled, chunk, window))).double().numpy())
    if not out:
        raise ValueError("no samples")
    return np.concatenate(out)


def mean_log_loss(model: nn.Module, scaled: F32, t: I64, y: I8, window: int) -> float:
    p = np.clip(predict_proba(model, scaled, t, window), 1e-7, 1 - 1e-7)
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))


def train(
    config: ModelConfig,
    scaled: F32,
    train_t: I64,
    train_y: I8,
    val_t: I64,
    val_y: I8,
    settings: TrainSettings = DEFAULT_SETTINGS,
) -> TrainResult:
    """Trains one model; `scaled` is the fold-scaled feature matrix (float32)."""
    for name, t, y in (("training", train_t, train_y), ("validation", val_t, val_y)):
        if len(t) == 0 or len(t) != len(y):
            raise ValueError(f"{name} samples are empty or misaligned")
    set_determinism(settings)
    model = build(config)
    optimiser = torch.optim.Adam(model.parameters(), lr=LEARNING_RATE)
    loss_fn = nn.BCEWithLogitsLoss()
    generator = np.random.default_rng(settings.seed)
    targets = torch.from_numpy(train_y.astype(np.float32))

    best_loss, best_epoch, best_state = math.inf, 0, copy.deepcopy(model.state_dict())
    history: list[dict[str, float]] = []
    started = time.perf_counter()
    for epoch in range(1, settings.max_epochs + 1):
        epoch_start = time.perf_counter()
        model.train()
        order = generator.permutation(len(train_t))
        total, seen = 0.0, 0
        for start in range(0, len(order), settings.batch_size):
            pick = order[start : start + settings.batch_size]
            x = batch_windows(scaled, train_t[pick], config.window)
            optimiser.zero_grad()
            loss = loss_fn(model(x), targets[pick])
            loss.backward()
            optimiser.step()
            total += loss.item() * len(pick)
            seen += len(pick)
        val_loss = mean_log_loss(model, scaled, val_t, val_y, config.window)
        history.append(
            {
                "epoch": epoch,
                "train_loss": total / seen,
                "val_loss": val_loss,
                "seconds": time.perf_counter() - epoch_start,
            }
        )
        if val_loss < best_loss:
            best_loss, best_epoch, best_state = val_loss, epoch, copy.deepcopy(model.state_dict())
        elif epoch - best_epoch >= settings.patience:
            break
    model.load_state_dict(best_state)
    model.eval()
    return TrainResult(model, best_epoch, best_loss, history, time.perf_counter() - started)


def shuffled(y: I8, seed: int) -> I8:
    """The training targets in a random order (the leakage control)."""
    if len(y) == 0:
        raise ValueError("no targets")
    out: I8 = np.random.default_rng(seed).permutation(y)
    return out
