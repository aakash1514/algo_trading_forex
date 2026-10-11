"""Walk-forward training and evaluation (offline).

For each pair and fold: fit the scaler on the training period, train every LSTM
setting and pick one by validation log loss, do the same for the logistic baseline,
then score everything once on the test year. All models and baselines of a fold see
exactly the same samples (chosen with the largest window, so every setting has a
full window).

    python -m ml_service.walk_forward --pairs EUR/USD --folds 2022 --out <dir>
"""

from __future__ import annotations

import argparse
import json
import time
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import numpy.typing as npt

from ml_service import baselines
from ml_service.data import PAIRS, Bars, read_bars
from ml_service.db import connect
from ml_service.features import bar_features, next_bar_targets, sample_indices
from ml_service.metrics import balanced_accuracy, brier, log_loss, wilson_interval
from ml_service.model import ModelConfig, save_state
from ml_service.splits import FOLDS, Fold, SplitIndices, fit_scaler, split_samples
from ml_service.training import TrainResult, TrainSettings, predict_proba, train

F64 = npt.NDArray[np.float64]
I8 = npt.NDArray[np.int8]

LSTM_GRID = tuple(ModelConfig("lstm", window=w, hidden=h) for h in (32, 64) for w in (32, 96))
LOGISTIC_GRID = tuple(ModelConfig("logistic", window=w) for w in (32, 96))
MAX_WINDOW = max(c.window for c in LSTM_GRID + LOGISTIC_GRID)
HISTORY_START = datetime(2010, 1, 1, tzinfo=UTC)
HISTORY_END = datetime(2023, 1, 1, tzinfo=UTC)


def scores(y: I8, pred: I8, p_up: F64 | None) -> dict[str, object]:
    hits = int(np.sum(pred == y))
    lo, hi = wilson_interval(hits, len(y))
    return {
        "n": len(y),
        "correct": hits,
        "accuracy": hits / len(y),
        "accuracy_ci95": [lo, hi],
        "balanced_accuracy": balanced_accuracy(y, pred),
        "log_loss": None if p_up is None else log_loss(y, p_up),
        "brier": None if p_up is None else brier(y, p_up),
    }


def select(
    grid: tuple[ModelConfig, ...],
    scaled: npt.NDArray[np.float32],
    s: SplitIndices,
    y_of: dict[str, I8],
    ts: TrainSettings,
) -> tuple[ModelConfig, TrainResult, list[dict[str, object]]]:
    tried: list[dict[str, object]] = []
    best: tuple[ModelConfig, TrainResult] | None = None
    for config in grid:
        r = train(config, scaled, s.train, y_of["train"], s.validation, y_of["validation"], ts)
        tried.append(
            {
                "config": config.name,
                "best_epoch": r.best_epoch,
                "epochs_run": len(r.history),
                "val_log_loss": r.best_val_loss,
                "seconds": r.seconds,
                "seconds_per_epoch": r.seconds / len(r.history),
            }
        )
        print(
            f"    {config.name:<16} epochs {len(r.history):>2} (best {r.best_epoch:>2})  "
            f"val log loss {r.best_val_loss:.6f}  {r.seconds:7.1f} s ({r.seconds / len(r.history):.1f} s/epoch)",
            flush=True,
        )
        if best is None or r.best_val_loss < best[1].best_val_loss:
            best = (config, r)
    assert best is not None
    return best[0], best[1], tried


def run_fold(bars: Bars, fold: Fold, ts: TrainSettings, out: Path | None) -> dict[str, object]:
    started = time.perf_counter()
    features = bar_features(bars)
    targets = next_bar_targets(bars)
    t = sample_indices(len(bars), targets, MAX_WINDOW)
    s = split_samples(t, bars.time, fold)
    y_of = {"train": targets[s.train], "validation": targets[s.validation], "test": targets[s.test]}
    scaler = fit_scaler(features, bars.time, fold)
    scaled = scaler.transform(features).astype(np.float32)
    print(
        f"  {bars.pair} {fold.name}: train {len(s.train)}, validation {len(s.validation)}, test {len(s.test)} samples",
        flush=True,
    )

    lstm_cfg, lstm, lstm_tried = select(LSTM_GRID, scaled, s, y_of, ts)
    logit_cfg, logit, logit_tried = select(LOGISTIC_GRID, scaled, s, y_of, ts)

    y = y_of["test"]
    p_lstm = predict_proba(lstm.model, scaled, s.test, lstm_cfg.window)
    p_logit = predict_proba(logit.model, scaled, s.test, logit_cfg.window)
    up_rate = baselines.training_up_rate(y_of["train"])
    preds: dict[str, tuple[I8, F64 | None]] = {
        "lstm": ((p_lstm >= 0.5).astype(np.int8), p_lstm),
        "logistic": ((p_logit >= 0.5).astype(np.int8), p_logit),
        "majority": (baselines.majority(y_of["train"], len(y)), np.full(len(y), up_rate)),
        "persistence": (baselines.persistence(bars, s.test, y_of["train"]), None),
        "anti_persistence": (baselines.anti_persistence(bars, s.test, y_of["train"]), None),
    }
    result: dict[str, object] = {
        "pair": bars.pair,
        "fold": fold.name,
        "test_year": fold.test_year,
        "samples": {k: len(v) for k, v in y_of.items()},
        "test_up_rate": float(np.mean(y)),
        "train_up_rate": up_rate,
        "scaler": scaler.to_dict(),
        "settings": asdict(ts),
        "lstm": {"chosen": lstm_cfg.name, "tried": lstm_tried},
        "logistic": {"chosen": logit_cfg.name, "tried": logit_tried},
        "test": {name: scores(y, pred, p) for name, (pred, p) in preds.items()},
        "seconds": time.perf_counter() - started,
    }
    if out is not None:
        stem = f"{bars.pair.replace('/', '')}-1h-{fold.name}"
        save_state(lstm.model, out / f"{stem}-lstm.pt")
        save_state(logit.model, out / f"{stem}-logistic.pt")
        np.savez_compressed(
            out / f"{stem}-test-predictions.npz",
            t=s.test,
            time=bars.time[s.test],
            y=y,
            p_lstm=p_lstm,
            p_logistic=p_logit,
        )
        (out / f"{stem}.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pairs", default=",".join(PAIRS))
    parser.add_argument("--folds", default=",".join(str(f.test_year) for f in FOLDS))
    parser.add_argument("--threads", type=int, default=TrainSettings().threads)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    ts = TrainSettings(threads=args.threads)
    pairs = [p.strip() for p in args.pairs.split(",")]
    folds = [Fold(int(y)) for y in args.folds.split(",")]
    args.out.mkdir(parents=True, exist_ok=True)
    with connect() as conn:
        loaded = {p: read_bars(conn, p, HISTORY_START, HISTORY_END) for p in pairs}
    for pair in pairs:
        print(f"{pair}: {len(loaded[pair])} H1 bars", flush=True)
        for fold in folds:
            r = run_fold(loaded[pair], fold, ts, args.out)
            test = r["test"]
            assert isinstance(test, dict)
            line = "  ".join(f"{k} {v['accuracy']:.4f}" for k, v in test.items())
            print(f"  -> {pair} {fold.name} test accuracy: {line}  ({r['seconds']:.0f} s)", flush=True)


if __name__ == "__main__":
    main()
