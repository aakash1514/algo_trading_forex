"""Builds models/manifest.json and docs/validation/ml-walk-forward.md from a finished
walk-forward run (offline). Every check fails on empty or incomplete input.

    python -m ml_service.report --models models --doc ../../docs/validation/ml-walk-forward.md
"""

from __future__ import annotations

import argparse
import json
import subprocess
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np
from scipy.stats import binomtest

from ml_service.config import REPO_ROOT, SERVICE_ROOT
from ml_service.data import PAIRS, read_bars
from ml_service.db import connect
from ml_service.metrics import ALPHA, holm, mcnemar, wilson_interval
from ml_service.splits import FOLDS
from ml_service.walk_forward import (
    CONTROL_YEAR,
    HISTORY_END,
    HISTORY_START,
    LOGISTIC_GRID,
    LSTM_GRID,
    MAX_WINDOW,
    file_sha256,
    stem,
)

BASELINES = ("logistic", "majority", "persistence", "anti_persistence")
LABELS = {
    "lstm": "LSTM",
    "logistic": "Logistic",
    "majority": "Majority",
    "persistence": "Persistence",
    "anti_persistence": "Anti-persistence",
}
SQL = SERVICE_ROOT / "sql" / "baseline_check.sql"


@dataclass
class Fold:
    meta: dict[str, Any]
    arrays: dict[str, np.ndarray]


def load_folds(models: Path) -> dict[tuple[str, int], Fold]:
    out: dict[tuple[str, int], Fold] = {}
    for pair in PAIRS:
        for f in FOLDS:
            name = stem(pair, f)
            meta_path = models / f"{name}.json"
            if not meta_path.is_file():
                raise SystemExit(f"missing fold {name}: the walk-forward run is incomplete")
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            for key in ("lstm", "logistic", "test_predictions"):
                path = models / meta["files"][key]["path"]
                if file_sha256(path) != meta["files"][key]["sha256"]:
                    raise SystemExit(f"{path.name}: sha256 differs from its fold JSON")
            with np.load(models / meta["files"]["test_predictions"]["path"]) as z:
                arrays = {k: z[k] for k in z.files}
            if len(arrays["y"]) == 0:
                raise SystemExit(f"{name}: no test samples")
            out[(pair, f.test_year)] = Fold(meta, arrays)
    return out


def pooled(folds: dict[tuple[str, int], Fold], pair: str) -> dict[str, np.ndarray]:
    parts = [folds[(pair, f.test_year)].arrays for f in FOLDS]
    return {k: np.concatenate([p[k] for p in parts]) for k in parts[0]}


def significance(folds: dict[tuple[str, int], Fold]) -> list[dict[str, Any]]:
    """The 16 pooled LSTM-vs-baseline McNemar tests with Holm-adjusted p-values."""
    rows: list[dict[str, Any]] = []
    for pair in PAIRS:
        z = pooled(folds, pair)
        y = z["y"].astype(np.int8)
        lstm = z["pred_lstm"].astype(np.int8)
        for b in BASELINES:
            other = z[f"pred_{b}"].astype(np.int8)
            m = mcnemar(y, lstm, other)
            rows.append(
                {
                    "pair": pair,
                    "baseline": b,
                    "n": len(y),
                    "lstm_correct": int(np.sum(lstm == y)),
                    "baseline_correct": int(np.sum(other == y)),
                    "lstm_only": m.a_only,
                    "baseline_only": m.b_only,
                    "p_raw": m.p_value,
                }
            )
    adjusted = holm([r["p_raw"] for r in rows])
    for r, p in zip(rows, adjusted, strict=True):
        r["p_holm"] = p
        r["lstm_accuracy"] = r["lstm_correct"] / r["n"]
        r["baseline_accuracy"] = r["baseline_correct"] / r["n"]
        r["lstm_ci95"] = list(wilson_interval(r["lstm_correct"], r["n"]))
        r["baseline_ci95"] = list(wilson_interval(r["baseline_correct"], r["n"]))
        r["beats"] = bool(r["lstm_correct"] > r["baseline_correct"] and p < ALPHA)
        r["significantly_worse"] = bool(r["lstm_correct"] < r["baseline_correct"] and p < ALPHA)
    return rows


def sql_baseline_check(folds: dict[tuple[str, int], Fold]) -> list[dict[str, Any]]:
    with connect() as conn:
        rows = conn.execute(SQL.read_text(encoding="utf-8"), {"pairs": list(PAIRS), "window": MAX_WINDOW}).fetchall()
    if len(rows) != len(PAIRS) * len(FOLDS):
        raise SystemExit(f"the SQL check returned {len(rows)} rows, expected {len(PAIRS) * len(FOLDS)}")
    out = []
    for pair, year, n, up, maj, pers, anti in rows:
        a = folds[(str(pair), int(str(year)))].arrays
        y = a["y"]
        python = {
            "n": len(y),
            "up": int(y.sum()),
            "majority_correct": int(np.sum(a["pred_majority"] == y)),
            "persistence_correct": int(np.sum(a["pred_persistence"] == y)),
            "anti_persistence_correct": int(np.sum(a["pred_anti_persistence"] == y)),
        }
        sql = {
            "n": int(str(n)),
            "up": int(str(up)),
            "majority_correct": int(str(maj)),
            "persistence_correct": int(str(pers)),
            "anti_persistence_correct": int(str(anti)),
        }
        out.append({"pair": pair, "test_year": year, "python": python, "sql": sql, "match": python == sql})
    return out


def spread_cost(folds: dict[tuple[str, int], Fold]) -> list[dict[str, Any]]:
    """Break-even accuracy for trading the predicted direction on each target bar: buy
    (sell) at the bar's open, close at its close, paying the bid/ask spread. With equal
    average win and loss sizes m and cost c: p*m - (1-p)*m - c = 0 -> p = 0.5 + c/(2m)."""
    out = []
    with connect() as conn:
        for pair in PAIRS:
            bars = read_bars(conn, pair, HISTORY_START, HISTORY_END)
            idx = np.concatenate([folds[(pair, f.test_year)].arrays["t"] for f in FOLDS]) + 1  # target bars
            move = np.abs((bars.bid_close[idx] + bars.ask_close[idx]) - (bars.bid_open[idx] + bars.ask_open[idx])) / 2
            cost = ((bars.ask_open[idx] - bars.bid_open[idx]) + (bars.ask_close[idx] - bars.bid_close[idx])) / 2
            m, c = float(move.mean()), float(cost.mean())
            out.append(
                {
                    "pair": pair,
                    "mean_move_pips": m / bars.pip_points,
                    "mean_spread_pips": c / bars.pip_points,
                    "break_even_accuracy": 0.5 + c / (2 * m),
                }
            )
    return out


def manifest(folds: dict[tuple[str, int], Fold], generated: str, commit: str) -> dict[str, Any]:
    models = []
    for (pair, year), f in sorted(folds.items()):
        m = f.meta
        models.append(
            {
                "pair": pair,
                "instrument": pair.replace("/", "_"),
                "timeframe": "1h",
                "test_year": year,
                "id": f"{pair.replace('/', '_')}-1h-test{year}",
                "periods": m["periods"],
                "samples": m["samples"],
                "bars_sha256": m["bars_sha256"],
                "scaler": m["scaler"],
                "lstm": {
                    "config": m["lstm"]["chosen"],
                    "window": m["lstm"]["window"],
                    "hidden": m["lstm"]["hidden"],
                    "file": m["files"]["lstm"],
                },
                "logistic": {
                    "config": m["logistic"]["chosen"],
                    "window": m["logistic"]["window"],
                    "file": m["files"]["logistic"],
                },
                "test_predictions": m["files"]["test_predictions"],
                "test": m["test"],
                "settings": m["settings"],
            }
        )
    return {
        "generated_at": generated,
        "commit": commit,
        "target": "direction of the next H1 bar, mid open to close",
        "features": "see ml_service.features.FEATURE_NAMES",
        "lstm_grid": [c.name for c in LSTM_GRID],
        "logistic_grid": [c.name for c in LOGISTIC_GRID],
        "models": models,
    }


def pct(x: float) -> str:
    return f"{100 * x:.2f}%"


def ci(correct: int, n: int) -> str:
    lo, hi = wilson_interval(correct, n)
    return f"{pct(correct / n)} [{100 * lo:.2f}, {100 * hi:.2f}]"


def pvalue(p: float) -> str:
    return f"{p:.2e}" if p < 1e-3 else f"{p:.4f}"


def render(
    folds: dict[tuple[str, int], Fold],
    sig: list[dict[str, Any]],
    sql: list[dict[str, Any]],
    controls: list[dict[str, Any]],
    repro: dict[str, Any],
    spread: list[dict[str, Any]],
    generated: str,
    commit: str,
) -> str:
    lines: list[str] = []
    lines.append("# ML walk-forward evaluation (step 4)")
    lines.append("")
    lines.append(
        f"Generated by `python -m ml_service.report` on {generated} at commit `{commit}`. Historical walk-forward"
    )
    lines.append("test on the imported Dukascopy history, **not live signals**.")
    lines.append("")
    lines.append("## Setup")
    lines.append("")
    lines.append("- **Target:** direction of the next H1 bar, mid open to close (exact in integer points); flat bars,")
    lines.append("  bars under 30 minutes and the last bar have no target.")
    lines.append(
        "- **Features (10, bars <= t only):** close-to-close, own open-to-close and gap log returns, log range,"
    )
    lines.append(
        "  spread in pips, log(minutes/60), sin/cos of hour and weekday. Scaled with training-period statistics."
    )
    lines.append(
        "- **Walk-forward:** per pair, 7 expanding folds; test year Y, validation Y-1, training 2010 to Y-2. A sample"
    )
    lines.append(
        "  belongs to the period of its target bar. Validation is used only for early stopping and model choice."
    )
    lines.append(
        f"- **Models:** LSTM grid {', '.join(c.name for c in LSTM_GRID)} (chosen per fold on validation log loss);"
    )
    lines.append(
        f"  logistic baseline {', '.join(c.name for c in LOGISTIC_GRID)}. Training: Adam 1e-3, batch 512, <= 40 epochs,"
    )
    lines.append(
        "  early stopping on validation log loss (patience 5), fixed seed, deterministic algorithms, 8 threads."
    )
    lines.append(
        "- **Grid decision (validation only):** window 96 was dropped after the timed round (EUR/USD, test 2022):"
    )
    lines.append(
        "  2.7x slower and no better on validation log loss (h32: 0.690491 at window 96 vs 0.690480 at window 32)."
    )
    lines.append(
        "- **Baselines (same samples):** logistic regression on the same window; majority direction of the training"
    )
    lines.append("  targets; persistence (next bar moves like bar t); anti-persistence (the opposite).")
    lines.append("")
    lines.append("## Rule (fixed before training)")
    lines.append("")
    lines.append(
        "The LSTM beats a baseline only if its pooled 2016-2022 accuracy is higher and the pooled McNemar test"
    )
    lines.append(
        f"(exact binomial on the discordant pairs) gives p < {ALPHA} after a Holm correction across all 16 pooled"
    )
    lines.append("LSTM-vs-baseline tests (4 pairs x 4 baselines). Raw and adjusted p-values are both shown.")
    lines.append("")
    lines.append("## Pooled results, 2016-2022")
    lines.append("")
    lines.append(
        "| Pair | Baseline | n | LSTM accuracy | Baseline accuracy | LSTM-only / baseline-only right "
        "| p (raw) | p (Holm) | Verdict |"
    )
    lines.append("|---|---|---|---|---|---|---|---|---|")
    for r in sig:
        verdict = (
            "**LSTM beats it**"
            if r["beats"]
            else ("LSTM significantly worse" if r["significantly_worse"] else "no evidence of a difference")
        )
        lines.append(
            f"| {r['pair']} | {LABELS[r['baseline']]} | {r['n']} | {ci(r['lstm_correct'], r['n'])} | "
            f"{ci(r['baseline_correct'], r['n'])} | {r['lstm_only']} / {r['baseline_only']} | {pvalue(r['p_raw'])} | "
            f"{pvalue(r['p_holm'])} | {verdict} |"
        )
    beats = [r for r in sig if r["beats"]]
    worse = [r for r in sig if r["significantly_worse"]]
    lines.append("")
    lines.append("## Conclusion")
    lines.append("")
    if beats:
        lines.append(f"Under the fixed rule the LSTM beats {len(beats)} of 16 pair-baseline comparisons: ")
        lines.append(", ".join(f"{b['pair']} vs {LABELS[b['baseline']]}" for b in beats) + ".")
    else:
        lines.append("Under the fixed rule the LSTM beats **none** of the 16 pair-baseline comparisons.")
    if worse:
        lines.append(
            f"It is significantly worse than the baseline in {len(worse)}: "
            + ", ".join(f"{w['pair']} vs {LABELS[w['baseline']]}" for w in worse)
            + "."
        )
    for b in BASELINES:
        not_beaten = [r["pair"] for r in sig if r["baseline"] == b and not r["beats"]]
        if len(not_beaten) == len(PAIRS):
            lines.append(f"It does not beat {LABELS[b].lower()} for any pair.")
    lstm_acc = {r["pair"]: r["lstm_accuracy"] for r in sig}
    below = [s for s in spread if lstm_acc[s["pair"]] < s["break_even_accuracy"]]
    lines.append(
        "The pooled LSTM accuracy is below the break-even accuracy (next paragraph) for "
        f"{len(below)} of {len(spread)} pairs"
        + (" (all of them): it would not cover the spread." if len(below) == len(spread) else ".")
    )
    lines.append("")
    lines.append(
        "Accuracy needed just to cover the spread: trading each predicted direction from the target bar's open to"
    )
    lines.append("its close pays about one spread, so with equal average win and loss sizes the break-even accuracy is")
    lines.append(
        "0.5 + spread / (2 x average move): "
        + "; ".join(
            f"{s['pair']} {pct(s['break_even_accuracy'])} "
            f"(spread {s['mean_spread_pips']:.2f} pips, move {s['mean_move_pips']:.2f} pips)"
            for s in spread
        )
        + "."
    )
    lines.append("")
    lines.append("## Per pair and test year")
    lines.append("")
    lines.append(
        "Accuracy with 95% Wilson interval; log loss for the probabilistic models (majority = training up-rate)."
    )
    lines.append("")
    lines.append(
        "| Pair | Year | n | Test up-rate | Chosen LSTM | LSTM | Logistic | Majority | Persistence "
        "| Anti-persistence | LSTM / majority log loss |"
    )
    lines.append("|---|---|---|---|---|---|---|---|---|---|---|")
    for (pair, year), f in sorted(folds.items()):
        t = f.meta["test"]
        n = t["lstm"]["n"]
        cells = " | ".join(
            ci(t[k]["correct"], n) for k in ("lstm", "logistic", "majority", "persistence", "anti_persistence")
        )
        lines.append(
            f"| {pair} | {year} | {n} | {pct(f.meta['test_up_rate'])} | {f.meta['lstm']['chosen']} | {cells} | "
            f"{t['lstm']['log_loss']:.4f} / {t['majority']['log_loss']:.4f} |"
        )
    lines.append("")
    lines.append("## Leakage control: shuffled training labels")
    lines.append("")
    lines.append(
        f"The chosen LSTM setting of each pair's {CONTROL_YEAR} fold, retrained on randomly shuffled training targets"
    )
    lines.append("(validation and test targets real). It must not beat the majority baseline.")
    lines.append("")
    lines.append(
        "| Pair | Setting | Control accuracy | Majority accuracy | McNemar p | Beats majority? (fixed check) |"
    )
    lines.append("|---|---|---|---|---|---|")
    for c in controls:
        lines.append(
            f"| {c['pair']} | {c['config']} | {ci(c['test']['correct'], c['test']['n'])} | "
            f"{ci(c['majority']['correct'], c['majority']['n'])} | {pvalue(c['mcnemar_vs_majority']['p_value'])} | "
            f"{'**yes: FAILED**' if c['beats_majority'] else 'no'} |"
        )
    lines.append("")
    if any(c["beats_majority"] for c in controls):
        lines.append(
            "**The fixed control check fails** for "
            + ", ".join(c["pair"] for c in controls if c["beats_majority"])
            + ". Diagnostic added after the run (not part of the fixed check): whether the control is above chance."
        )
        lines.append("")
        lines.append("| Pair | Train up-rate | Test up-rate | Control balanced accuracy | Control vs 50%: binomial p |")
        lines.append("|---|---|---|---|---|")
        for c in controls:
            meta = folds[(c["pair"], CONTROL_YEAR)].meta
            p_chance = float(binomtest(c["test"]["correct"], c["test"]["n"], 0.5).pvalue)
            lines.append(
                f"| {c['pair']} | {pct(meta['train_up_rate'])} | {pct(meta['test_up_rate'])} | "
                f"{c['test']['balanced_accuracy']:.4f} | {pvalue(p_chance)} |"
            )
        lines.append("")
        lines.append(
            "Reading: a control trained on shuffled labels should predict at chance, i.e. a balanced accuracy near"
        )
        lines.append(
            "0.5. The majority baseline predicts the training years' more common direction; when the test year's"
        )
        lines.append(
            "balance flips, that baseline scores below 50% and any chance-level predictor beats it. The check is"
        )
        lines.append("left as fixed and reported as failed; the criterion question is in docs/OVERNIGHT-QUESTIONS.md.")
        lines.append("")
    lines.append("## Reproducibility")
    lines.append("")
    lines.append(
        f"{repro['pair']} {repro['fold']} ({repro['config']}) retrained from scratch: state_dict "
        f"{'**identical, tensor for tensor**' if repro['state_dict_equal'] else '**DIFFERENT**'} "
        f"({len(repro['tensors'])} tensors; best epoch {repro['best_epoch_saved']} saved / "
        f"{repro['best_epoch_rerun']} rerun)."
    )
    lines.append(
        f"For traceability only: file sha256 saved `{repro['sha256_saved'][:16]}...`, "
        f"rerun `{repro['sha256_rerun'][:16]}...`;"
        f" bars sha256 {'equal' if repro['bars_sha256_saved'] == repro['bars_sha256_rerun'] else 'DIFFERENT'}."
    )
    lines.append("")
    lines.append("## Independent SQL check of samples and baselines")
    lines.append("")
    lines.append(
        "`apps/ml-service/sql/baseline_check.sql` recounts, from the H1 bars in SQL, each pair-year's test samples,"
    )
    lines.append("up targets and the majority / persistence / anti-persistence hits. Python vs SQL:")
    lines.append("")
    lines.append("| Pair | Year | n | Up | Majority | Persistence | Anti-persistence | Match |")
    lines.append("|---|---|---|---|---|---|---|---|")
    for s in sql:
        p, q = s["python"], s["sql"]

        def cell(k: str, p: dict[str, int] = p, q: dict[str, int] = q) -> str:
            return str(p[k]) if p[k] == q[k] else f"{p[k]} vs {q[k]}"

        lines.append(
            f"| {s['pair']} | {s['test_year']} | {cell('n')} | {cell('up')} | {cell('majority_correct')} | "
            f"{cell('persistence_correct')} | {cell('anti_persistence_correct')} | "
            f"{'yes' if s['match'] else '**NO**'} |"
        )
    lines.append("")
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", type=Path, default=SERVICE_ROOT / "models")
    parser.add_argument("--doc", type=Path, default=REPO_ROOT / "docs" / "validation" / "ml-walk-forward.md")
    args = parser.parse_args()
    folds = load_folds(args.models)
    generated = datetime.now(UTC).strftime("%Y-%m-%d %H:%M UTC")
    commit = subprocess.run(
        ["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True, check=True, cwd=REPO_ROOT
    ).stdout.strip()
    sig = significance(folds)
    sql = sql_baseline_check(folds)
    controls = []
    for pair in PAIRS:
        path = args.models / f"{pair.replace('/', '')}-1h-test{CONTROL_YEAR}-shuffled.json"
        if not path.is_file():
            raise SystemExit(f"missing shuffled-label control {path.name}")
        controls.append(json.loads(path.read_text(encoding="utf-8")))
    repro_files = sorted(args.models.glob("*-reproduce.json"))
    if not repro_files:
        raise SystemExit("missing the reproducibility rerun")
    repro = json.loads(repro_files[0].read_text(encoding="utf-8"))
    spread = spread_cost(folds)
    (args.models / "manifest.json").write_text(
        json.dumps(manifest(folds, generated, commit), indent=2), encoding="utf-8"
    )
    evaluation = {
        "generated_at": generated,
        "commit": commit,
        "significance": sig,
        "controls": controls,
        "reproducibility": repro,
        "sql_check": sql,
        "break_even": spread,
    }
    (args.models / "evaluation.json").write_text(json.dumps(evaluation, indent=2), encoding="utf-8")
    args.doc.write_text(render(folds, sig, sql, controls, repro, spread, generated, commit), encoding="utf-8")
    failed = [s for s in sql if not s["match"]]
    print(f"report: {args.doc}")
    print(f"SQL check: {len(sql) - len(failed)}/{len(sql)} pair-years match")
    print(f"LSTM beats {sum(r['beats'] for r in sig)} of {len(sig)} comparisons under the Holm rule")
    if failed or not repro["state_dict_equal"] or any(c["beats_majority"] for c in controls):
        raise SystemExit("a verification check failed (see the report)")


if __name__ == "__main__":
    main()
