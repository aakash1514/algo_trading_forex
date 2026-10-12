"""Walk-forward training and evaluation (offline).

For each pair and fold: fit the scaler on the training period, train every LSTM
setting and pick one by validation log loss, train the logistic baseline, then score
everything once on the test year. All models and baselines of a fold see exactly the
same samples.

Grid: LSTM hidden {32, 64} with window 32; logistic window 32. Window 96 was dropped
after the timed round (EUR/USD, test 2022) on validation evidence only: 2.7x slower
and no better on validation log loss (h32: 0.690491 at w96 vs 0.690480 at w32).

Resumable: each finished pair/test-year writes its models, test predictions and JSON
at once (the JSON last, atomically, as the completion marker); a restart skips folds
whose JSON and model files exist with matching sha256.

    python -m ml_service.walk_forward --out models                     # all pairs and folds
    python -m ml_service.walk_forward --out models --control-shuffled  # label-shuffle control
    python -m ml_service.walk_forward --out models --reproduce EUR/USD:2022
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
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
from ml_service.metrics import balanced_accuracy, brier, log_loss, mcnemar, wilson_interval
from ml_service.model import ModelConfig, load_model, same_state, save_state
from ml_service.splits import FOLDS, Fold, SplitIndices, fit_scaler, split_samples
from ml_service.training import TrainResult, TrainSettings, predict_proba, shuffled, train

F64 = npt.NDArray[np.float64]
F32 = npt.NDArray[np.float32]
I8 = npt.NDArray[np.int8]

LSTM_GRID = tuple(ModelConfig("lstm", window=32, hidden=h) for h in (32, 64))
LOGISTIC_GRID = (ModelConfig("logistic", window=32),)
MAX_WINDOW = max(c.window for c in LSTM_GRID + LOGISTIC_GRID)
HISTORY_START = datetime(2010, 1, 1, tzinfo=UTC)
HISTORY_END = datetime(2023, 1, 1, tzinfo=UTC)
SHUFFLE_SEED = 777
CONTROL_YEAR = 2022


def log(message: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {message}", flush=True)


def stem(pair: str, fold: Fold) -> str:
    return f"{pair.replace('/', '')}-1h-{fold.name}"


def bars_sha256(bars: Bars) -> str:
    """Traceability: hash of the exact integer bars a fold was trained on."""
    h = hashlib.sha256(bars.pair.encode())
    for col in (
        "time",
        "bid_open",
        "bid_high",
        "bid_low",
        "bid_close",
        "ask_open",
        "ask_high",
        "ask_low",
        "ask_close",
        "minutes",
    ):
        h.update(np.ascontiguousarray(getattr(bars, col)).tobytes())
    return h.hexdigest()


def file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json_atomic(path: Path, data: object) -> None:
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    os.replace(tmp, path)


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


class Prepared:
    """A fold's samples, targets and fold-scaled features."""

    def __init__(self, bars: Bars, fold: Fold) -> None:
        features = bar_features(bars)
        targets = next_bar_targets(bars)
        t = sample_indices(len(bars), targets, MAX_WINDOW)
        self.bars = bars
        self.fold = fold
        self.split: SplitIndices = split_samples(t, bars.time, fold)
        self.y = {
            "train": targets[self.split.train],
            "validation": targets[self.split.validation],
            "test": targets[self.split.test],
        }
        self.scaler = fit_scaler(features, bars.time, fold)
        self.scaled: F32 = self.scaler.transform(features).astype(np.float32)


def select(
    grid: tuple[ModelConfig, ...], p: Prepared, ts: TrainSettings
) -> tuple[ModelConfig, TrainResult, list[dict[str, object]]]:
    tried: list[dict[str, object]] = []
    best: tuple[ModelConfig, TrainResult] | None = None
    for config in grid:
        r = train(config, p.scaled, p.split.train, p.y["train"], p.split.validation, p.y["validation"], ts)
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
        log(
            f"    {config.name:<16} epochs {len(r.history):>2} (best {r.best_epoch:>2})  "
            f"val log loss {r.best_val_loss:.6f}  {r.seconds:7.1f} s ({r.seconds / len(r.history):.1f} s/epoch)"
        )
        if best is None or r.best_val_loss < best[1].best_val_loss:
            best = (config, r)
    assert best is not None
    return best[0], best[1], tried


def run_fold(bars: Bars, fold: Fold, ts: TrainSettings, out: Path) -> dict[str, object]:
    started = time.perf_counter()
    p = Prepared(bars, fold)
    s = p.split
    log(f"  {bars.pair} {fold.name}: train {len(s.train)}, validation {len(s.validation)}, test {len(s.test)} samples")

    lstm_cfg, lstm, lstm_tried = select(LSTM_GRID, p, ts)
    logit_cfg, logit, logit_tried = select(LOGISTIC_GRID, p, ts)

    y = p.y["test"]
    p_lstm = predict_proba(lstm.model, p.scaled, s.test, lstm_cfg.window)
    p_logit = predict_proba(logit.model, p.scaled, s.test, logit_cfg.window)
    up_rate = baselines.training_up_rate(p.y["train"])
    preds: dict[str, tuple[I8, F64 | None]] = {
        "lstm": ((p_lstm >= 0.5).astype(np.int8), p_lstm),
        "logistic": ((p_logit >= 0.5).astype(np.int8), p_logit),
        "majority": (baselines.majority(p.y["train"], len(y)), np.full(len(y), up_rate)),
        "persistence": (baselines.persistence(bars, s.test, p.y["train"]), None),
        "anti_persistence": (baselines.anti_persistence(bars, s.test, p.y["train"]), None),
    }
    name = stem(bars.pair, fold)
    lstm_path = out / f"{name}-lstm.pt"
    logit_path = out / f"{name}-logistic.pt"
    pred_path = out / f"{name}-test.npz"
    save_state(lstm.model, lstm_path)
    save_state(logit.model, logit_path)
    np.savez_compressed(
        pred_path,
        t=s.test,
        time=bars.time[s.test],
        target_time=bars.time[s.test + 1],
        y=y,
        p_lstm=p_lstm,
        p_logistic=p_logit,
        pred_lstm=preds["lstm"][0],
        pred_logistic=preds["logistic"][0],
        pred_majority=preds["majority"][0],
        pred_persistence=preds["persistence"][0],
        pred_anti_persistence=preds["anti_persistence"][0],
    )
    result: dict[str, object] = {
        "pair": bars.pair,
        "fold": fold.name,
        "test_year": fold.test_year,
        "periods": {"train": fold.train, "validation": fold.validation, "test": fold.test},
        "samples": {k: len(v) for k, v in p.y.items()},
        "train_up_rate": up_rate,
        "test_up_rate": float(np.mean(y)),
        "scaler": p.scaler.to_dict(),
        "settings": asdict(ts),
        "bars_sha256": bars_sha256(bars),
        "lstm": {"chosen": lstm_cfg.name, "window": lstm_cfg.window, "hidden": lstm_cfg.hidden, "tried": lstm_tried},
        "logistic": {"chosen": logit_cfg.name, "window": logit_cfg.window, "tried": logit_tried},
        "files": {
            "lstm": {"path": lstm_path.name, "sha256": file_sha256(lstm_path)},
            "logistic": {"path": logit_path.name, "sha256": file_sha256(logit_path)},
            "test_predictions": {"path": pred_path.name, "sha256": file_sha256(pred_path)},
        },
        "test": {k: scores(y, pred, prob) for k, (pred, prob) in preds.items()},
        "seconds": time.perf_counter() - started,
        "finished_at": datetime.now(UTC).isoformat(),
    }
    write_json_atomic(out / f"{name}.json", result)  # last: marks the fold finished
    return result


def finished(out: Path, pair: str, fold: Fold) -> bool:
    path = out / f"{stem(pair, fold)}.json"
    if not path.is_file():
        return False
    try:
        files = json.loads(path.read_text(encoding="utf-8"))["files"]
        return all(
            (out / files[k]["path"]).is_file() and file_sha256(out / files[k]["path"]) == files[k]["sha256"]
            for k in ("lstm", "logistic", "test_predictions")
        )
    except (ValueError, KeyError, TypeError):
        return False


def train_samples(bars: Bars, fold: Fold) -> int:
    t = sample_indices(len(bars), next_bar_targets(bars), MAX_WINDOW)
    return len(split_samples(t, bars.time, fold).train)


def run_all(loaded: dict[str, Bars], folds: list[Fold], ts: TrainSettings, out: Path) -> None:
    todo = [(p, f) for p in loaded for f in folds]
    remaining = [(p, f) for p, f in todo if not finished(out, p, f)]
    log(f"{len(todo) - len(remaining)} of {len(todo)} folds already finished; {len(remaining)} to run")
    work = {(p, f.test_year): train_samples(loaded[p], f) for p, f in remaining}
    total_work = sum(work.values())
    done_work, done_seconds = 0, 0.0
    for i, (pair, fold) in enumerate(remaining, 1):
        r = run_fold(loaded[pair], fold, ts, out)
        seconds = float(str(r["seconds"]))
        done_work += work[(pair, fold.test_year)]
        done_seconds += seconds
        eta = done_seconds / done_work * (total_work - done_work)  # time scales with the training samples
        test = r["test"]
        assert isinstance(test, dict)
        accs = "  ".join(f"{k} {v['accuracy']:.4f}" for k, v in test.items())
        log(f"  -> {pair} {fold.name} done in {seconds:.0f} s ({i}/{len(remaining)}): {accs}; ETA {eta / 3600:.2f} h")


def run_shuffled_control(loaded: dict[str, Bars], ts: TrainSettings, out: Path) -> None:
    """The chosen LSTM setting of the CONTROL_YEAR fold retrained on shuffled training
    targets (validation and test targets stay real), scored on the test year against
    the majority baseline. It must not beat it: if it did, the inputs would carry
    information that doesn't come through the labels (a leak)."""
    fold = Fold(CONTROL_YEAR)
    for pair, bars in loaded.items():
        name = stem(pair, fold)
        path = out / f"{name}-shuffled.json"
        if path.is_file():
            log(f"  {pair}: shuffled-label control already done")
            continue
        chosen = json.loads((out / f"{name}.json").read_text(encoding="utf-8"))["lstm"]
        cfg = ModelConfig("lstm", window=int(chosen["window"]), hidden=int(chosen["hidden"]))
        p = Prepared(bars, fold)
        log(f"  {pair} {fold.name}: shuffled-label control with {cfg.name}")
        y_shuffled = shuffled(p.y["train"], SHUFFLE_SEED)
        r = train(cfg, p.scaled, p.split.train, y_shuffled, p.split.validation, p.y["validation"], ts)
        y = p.y["test"]
        prob = predict_proba(r.model, p.scaled, p.split.test, cfg.window)
        pred = (prob >= 0.5).astype(np.int8)
        maj = baselines.majority(p.y["train"], len(y))
        m = mcnemar(y, pred, maj)
        result = {
            "pair": pair,
            "fold": fold.name,
            "config": cfg.name,
            "shuffle_seed": SHUFFLE_SEED,
            "best_epoch": r.best_epoch,
            "test": scores(y, pred, prob),
            "majority": scores(y, maj, None),
            "mcnemar_vs_majority": {"control_only": m.a_only, "majority_only": m.b_only, "p_value": m.p_value},
            "beats_majority": bool(np.mean(pred == y) > np.mean(maj == y) and m.p_value < 0.05),
        }
        write_json_atomic(path, result)
        log(f"  -> {pair} control {np.mean(pred == y):.4f} vs majority {np.mean(maj == y):.4f}, p {m.p_value:.4f}")


def run_reproduce(loaded: dict[str, Bars], spec: str, ts: TrainSettings, out: Path) -> None:
    """Retrains a finished fold's chosen LSTM from scratch and compares the state_dict
    tensor for tensor with the saved model; file sha256s are recorded only for
    traceability."""
    pair, year = spec.split(":")
    fold = Fold(int(year))
    name = stem(pair, fold)
    saved = json.loads((out / f"{name}.json").read_text(encoding="utf-8"))
    cfg = ModelConfig("lstm", window=int(saved["lstm"]["window"]), hidden=int(saved["lstm"]["hidden"]))
    p = Prepared(loaded[pair], fold)
    log(f"  reproducing {pair} {fold.name} {cfg.name}")
    r = train(cfg, p.scaled, p.split.train, p.y["train"], p.split.validation, p.y["validation"], ts)
    rerun_path = out / f"{name}-lstm-rerun.tmp"
    save_state(r.model, rerun_path)
    original = load_model(cfg, out / saved["files"]["lstm"]["path"])
    equal = same_state(original, r.model)
    result = {
        "pair": pair,
        "fold": fold.name,
        "config": cfg.name,
        "state_dict_equal": equal,
        "tensors": {k: list(v.shape) for k, v in original.state_dict().items()},
        "sha256_saved": saved["files"]["lstm"]["sha256"],
        "sha256_rerun": file_sha256(rerun_path),
        "bars_sha256_saved": saved["bars_sha256"],
        "bars_sha256_rerun": bars_sha256(loaded[pair]),
        "best_epoch_saved": next(t["best_epoch"] for t in saved["lstm"]["tried"] if t["config"] == cfg.name),
        "best_epoch_rerun": r.best_epoch,
    }
    rerun_path.unlink()
    write_json_atomic(out / f"{name}-reproduce.json", result)
    log(f"  -> state_dict equal: {equal}")
    if not equal:
        raise SystemExit("reproducibility check FAILED: the retrained state_dict differs")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pairs", default=",".join(PAIRS))
    parser.add_argument("--folds", default=",".join(str(f.test_year) for f in FOLDS))
    parser.add_argument("--threads", type=int, default=TrainSettings().threads)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--control-shuffled", action="store_true")
    parser.add_argument("--reproduce", metavar="PAIR:YEAR")
    args = parser.parse_args()
    ts = TrainSettings(threads=args.threads)
    pairs = [args.reproduce.split(":")[0]] if args.reproduce else [p.strip() for p in args.pairs.split(",")]
    folds = [Fold(int(y)) for y in args.folds.split(",")]
    args.out.mkdir(parents=True, exist_ok=True)
    with connect() as conn:
        loaded = {p: read_bars(conn, p, HISTORY_START, HISTORY_END) for p in pairs}
    for pair, bars in loaded.items():
        log(f"{pair}: {len(bars)} H1 bars, sha256 {bars_sha256(bars)[:16]}")
    if args.reproduce:
        run_reproduce(loaded, args.reproduce, ts, args.out)
    elif args.control_shuffled:
        run_shuffled_control(loaded, ts, args.out)
    else:
        run_all(loaded, folds, ts, args.out)


if __name__ == "__main__":
    main()
