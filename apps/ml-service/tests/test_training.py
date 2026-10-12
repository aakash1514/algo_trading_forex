"""Training on real H1 bars (EUR/USD January 2022) with a tiny setting, for speed."""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import numpy as np
import pytest

from ml_service.data import read_csv
from ml_service.features import bar_features, next_bar_targets, sample_indices, windows
from ml_service.model import ModelConfig, load_model, same_state, save_state
from ml_service.training import (
    TrainResult,
    TrainSettings,
    batch_windows,
    mean_log_loss,
    predict_proba,
    shuffled,
    train,
)

FIXTURES = Path(__file__).parent / "fixtures"
WINDOW = 8
SETTINGS = TrainSettings(threads=2, max_epochs=6, patience=2, batch_size=64)


@pytest.fixture(scope="module")
def data() -> dict[str, np.ndarray]:
    bars = read_csv(FIXTURES / "EURUSD-H1-2022-01.csv", "EUR/USD", pip_points=10)
    f = bar_features(bars)
    y = next_bar_targets(bars)
    t = sample_indices(len(bars), y, WINDOW)
    train_t, val_t = t[:350], t[350:]
    rows = f[1 : train_t.max() + 1]  # scaler from the training bars only
    mean, std = rows.mean(axis=0), rows.std(axis=0)
    std[std == 0] = 1
    scaled = ((f - mean) / std).astype(np.float32)
    return {"f": f, "scaled": scaled, "train_t": train_t, "train_y": y[train_t], "val_t": val_t, "val_y": y[val_t]}


def fit(data: dict[str, np.ndarray], config: ModelConfig, settings: TrainSettings = SETTINGS) -> TrainResult:
    return train(config, data["scaled"], data["train_t"], data["train_y"], data["val_t"], data["val_y"], settings)


LSTM = ModelConfig("lstm", window=WINDOW, hidden=4)


def test_batches_are_the_feature_windows(data: dict[str, np.ndarray]) -> None:
    t = data["train_t"][:20]
    expected = windows(data["scaled"].astype(np.float64), t, WINDOW).astype(np.float32)
    np.testing.assert_array_equal(batch_windows(data["scaled"], t, WINDOW).numpy(), expected)


def test_training_is_reproducible_tensor_for_tensor(data: dict[str, np.ndarray]) -> None:
    a = fit(data, LSTM)
    b = fit(data, LSTM)
    assert same_state(a.model, b.model)
    np.testing.assert_array_equal(
        predict_proba(a.model, data["scaled"], data["val_t"], WINDOW),
        predict_proba(b.model, data["scaled"], data["val_t"], WINDOW),
    )
    c = fit(data, LSTM, replace(SETTINGS, seed=SETTINGS.seed + 1))
    assert not same_state(a.model, c.model)  # the comparison does detect a different run


def test_the_best_epoch_is_restored_and_patience_respected(data: dict[str, np.ndarray]) -> None:
    r = fit(data, LSTM)
    val_losses = [h["val_loss"] for h in r.history]
    assert r.best_val_loss == min(val_losses) == val_losses[r.best_epoch - 1]
    assert mean_log_loss(r.model, data["scaled"], data["val_t"], data["val_y"], WINDOW) == r.best_val_loss
    assert len(r.history) <= min(SETTINGS.max_epochs, r.best_epoch + SETTINGS.patience)


def test_save_and_load_give_the_same_tensors_and_predictions(data: dict[str, np.ndarray], tmp_path: Path) -> None:
    for config in (LSTM, ModelConfig("logistic", window=WINDOW)):
        r = fit(data, config)
        path = tmp_path / f"{config.name}.pt"
        save_state(r.model, path)
        loaded = load_model(config, path)
        assert same_state(r.model, loaded)
        np.testing.assert_array_equal(
            predict_proba(r.model, data["scaled"], data["val_t"], WINDOW),
            predict_proba(loaded, data["scaled"], data["val_t"], WINDOW),
        )


def test_probabilities_are_probabilities(data: dict[str, np.ndarray]) -> None:
    p = predict_proba(fit(data, LSTM).model, data["scaled"], data["val_t"], WINDOW)
    assert len(p) == len(data["val_t"]) and ((p > 0) & (p < 1)).all()


def test_shuffled_targets_keep_the_counts_in_a_new_order(data: dict[str, np.ndarray]) -> None:
    y = data["train_y"]
    s = shuffled(y, 7)
    assert sorted(s.tolist()) == sorted(y.tolist()) and not np.array_equal(s, y)
    np.testing.assert_array_equal(s, shuffled(y, 7))


def test_empty_input_fails(data: dict[str, np.ndarray]) -> None:
    empty = np.array([], dtype=np.int64)
    with pytest.raises(ValueError, match="empty or misaligned"):
        train(LSTM, data["scaled"], empty, np.array([], dtype=np.int8), data["val_t"], data["val_y"], SETTINGS)
    with pytest.raises(ValueError, match="no samples"):
        batch_windows(data["scaled"], empty, WINDOW)
    with pytest.raises(ValueError):
        shuffled(np.array([], dtype=np.int8), 1)
