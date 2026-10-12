"""ML tools: the step-4 walk-forward evaluation and out-of-sample predictions, read from
ml-service (GET /api/ml/evaluation and /api/ml/predictions/{instrument}) with the caller's own
access token forwarded unchanged; this service holds no credential of its own for ml-service.

Values are ml-service's. Fractions are converted to percent (x 100, unrounded) so every
number carries a unit suffix. Two things are derived here, from ml-service's own numbers:
  below_break_even = pooled LSTM accuracy < break-even accuracy (the spread)
  conclusion       a fixed sentence chosen by below_break_even
Predictions are summarised, never returned one by one, and always carry ml-service's
disclaimer ("historical walk-forward test, not live signals")."""

from __future__ import annotations

import calendar
import os
from dataclasses import dataclass, field
from typing import Any

import httpx

from research_agent.config import REPO_ROOT, load_env_file
from research_agent.domain import ToolError, check_pair

TEST_YEARS = range(2016, 2023)
BASELINES = ("logistic", "majority", "persistence", "anti_persistence")
MODELS = ("lstm", *BASELINES)

CONCLUSION_BELOW = (
    "The LSTM's pooled out-of-sample accuracy is below the accuracy needed to cover the average spread, "
    "so its predictions are not tradable. This is a historical walk-forward test, not live signals."
)
CONCLUSION_ABOVE = (
    "The LSTM's pooled out-of-sample accuracy is above the spread break-even in this historical test. "
    "This is still a historical walk-forward test, not live signals, and not advice."
)


@dataclass(frozen=True)
class MlClient:
    http: httpx.Client
    token: str = field(repr=False)

    def get(self, path: str, params: dict[str, str] | None = None) -> dict[str, Any]:
        try:
            r = self.http.get(path, params=params, headers={"Authorization": f"Bearer {self.token}"})
        except httpx.HTTPError as err:
            raise ToolError("UPSTREAM_ERROR", "ml-service is unavailable") from err
        if r.status_code == 401:
            raise ToolError("UPSTREAM_ERROR", "ml-service refused the caller's token")
        if r.status_code in (404, 422):
            detail = (
                r.json().get("detail") if r.headers.get("content-type", "").startswith("application/json") else None
            )
            raise ToolError("OUT_OF_DATA" if r.status_code == 404 else "INVALID_ARGUMENT", str(detail or r.status_code))
        if r.status_code != 200:
            raise ToolError("UPSTREAM_ERROR", f"ml-service answered HTTP {r.status_code}")
        body: dict[str, Any] = r.json()
        return body


def ml_base_url() -> str:
    load_env_file(REPO_ROOT / ".env")
    return os.environ.get("ML_SERVICE_URL") or "http://localhost:3006/api/ml"


def _pct(fraction: float) -> float:
    return fraction * 100


def get_ml_evaluation(ml: MlClient, pair: str) -> dict[str, Any]:
    pair = check_pair(pair)
    ev = ml.get("/evaluation")
    rows = [r for r in ev["pooled"] if r["pair"] == pair]
    if sorted(r["baseline"] for r in rows) != sorted(BASELINES):
        raise ToolError("UPSTREAM_ERROR", f"ml-service's evaluation has no complete pooled tests for {pair}")
    lstm = {(r["n"], r["lstm_accuracy"], tuple(r["lstm_ci95"])) for r in rows}
    if len(lstm) != 1:
        raise ToolError("UPSTREAM_ERROR", "ml-service's pooled rows disagree on the LSTM's accuracy")
    n, accuracy, (ci_lo, ci_hi) = lstm.pop()
    be = [b for b in ev["breakEven"] if b["pair"] == pair]
    if len(be) != 1:
        raise ToolError("UPSTREAM_ERROR", f"ml-service's evaluation has no break-even accuracy for {pair}")
    below = accuracy < be[0]["break_even_accuracy"]
    return {
        "pair": pair,
        "target": ev["target"],
        "disclaimer": ev["disclaimer"],
        "rule": ev["rule"],
        "test_years": f"{TEST_YEARS[0]}-{TEST_YEARS[-1]}",
        "samples_count": n,
        "lstm_accuracy_pct": _pct(accuracy),
        "lstm_ci95_low_pct": _pct(ci_lo),
        "lstm_ci95_high_pct": _pct(ci_hi),
        "baselines": [
            {
                "baseline": r["baseline"],
                "baseline_accuracy_pct": _pct(r["baseline_accuracy"]),
                "raw_p": r["p_raw"],
                "holm_p": r["p_holm"],
                "lstm_beats_baseline": r["beats"],
                "lstm_significantly_worse": r["significantly_worse"],
            }
            for r in sorted(rows, key=lambda r: BASELINES.index(r["baseline"]))
        ],
        "baselines_beaten_count": sum(1 for r in rows if r["beats"]),
        "break_even_accuracy_pct": _pct(be[0]["break_even_accuracy"]),
        "mean_spread_pips": be[0]["mean_spread_pips"],
        "mean_move_pips": be[0]["mean_move_pips"],
        "below_break_even": below,
        "derived": "below_break_even and conclusion are derived here from ml-service's lstm accuracy and break-even",
        "conclusion": CONCLUSION_BELOW if below else CONCLUSION_ABOVE,
    }


def _year(year: int) -> int:
    if year not in TEST_YEARS:
        raise ToolError(
            "OUT_OF_DATA",
            f"model predictions exist only for the walk-forward test years {TEST_YEARS[0]}-{TEST_YEARS[-1]}",
        )
    return year


def get_ml_predictions(ml: MlClient, pair: str, year: int, month: int | None = None) -> dict[str, Any]:
    pair, year = check_pair(pair), _year(year)
    instrument = pair.replace("/", "_")
    if month is None:
        ev = ml.get("/evaluation")
        entries = [e for e in ev["perYear"] if e["instrument"] == instrument and e["testYear"] == year]
        if len(entries) != 1:
            raise ToolError("UPSTREAM_ERROR", f"ml-service's evaluation has no {pair} {year} model")
        test = entries[0]["test"]
        return {
            "pair": pair,
            "year": year,
            "disclaimer": ev["disclaimer"],
            "target": ev["target"],
            "chosen_lstm": entries[0]["chosenLstm"],
            "models": [
                {
                    "model": m,
                    "samples_count": test[m]["n"],
                    "correct_count": test[m]["correct"],
                    "accuracy_pct": _pct(test[m]["accuracy"]),
                    "balanced_accuracy_pct": _pct(test[m]["balanced_accuracy"]),
                }
                for m in MODELS
            ],
        }
    if not 1 <= month <= 12:
        raise ToolError("INVALID_ARGUMENT", "month must be 1 to 12")
    last = calendar.monthrange(year, month)[1]
    body = ml.get(
        f"/predictions/{instrument}",
        {"timeframe": "1h", "from": f"{year}-{month:02d}-01", "to": f"{year}-{month:02d}-{last:02d}"},
    )
    rows = body["predictions"]
    if not rows:
        raise ToolError("NO_BARS", f"no predictions for {pair} in {year}-{month:02d}")
    scored = [r for r in rows if r["scored"]]
    correct = sum(1 for r in scored if r["predicted"] == r["actual"])
    return {
        "pair": pair,
        "year": year,
        "month": month,
        "disclaimer": body["disclaimer"],
        "target": body["target"],
        "predictions_count": len(rows),
        "scored_count": len(scored),
        "unscored_note": "flat or short target bars are not scored",
        "correct_count": correct,
        "hit_rate_pct": correct / len(scored) * 100 if scored else None,
        "predicted_up_count": sum(1 for r in scored if r["predicted"] == "UP"),
        "predicted_down_count": sum(1 for r in scored if r["predicted"] == "DOWN"),
        "first_target_bar_utc": rows[0]["targetBarTime"],
        "last_target_bar_utc": rows[-1]["targetBarTime"],
        "models": sorted({r["model"] for r in rows}),
    }
