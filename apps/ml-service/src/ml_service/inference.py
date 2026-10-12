"""Inference with the walk-forward models (no training here).

A prediction for target bar t+1 uses the model of the fold whose TEST year contains
that bar, so every prediction served is out of sample: that model never saw the year.
Only 2016-2022 can be served. Features and scaling are exactly the offline ones
(ml_service.features + the fold's stored scaler).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import numpy as np
import psycopg

from ml_service.data import Bars, price_decimals, read_bars
from ml_service.features import NO_TARGET, bar_features, next_bar_targets
from ml_service.model import ModelConfig, load_model
from ml_service.splits import TEST_YEARS, Scaler
from ml_service.training import predict_proba

MAX_DAYS = 31
# Bars loaded before the range so that every window (and its row's previous bar) exists
LOOKBACK = timedelta(days=21)


class PredictionError(ValueError):
    """A request that can't be served (an unknown pair -> 404, a bad range -> 422)."""

    def __init__(self, message: str, status: int) -> None:
        super().__init__(message)
        self.status = status


@dataclass
class LoadedModel:
    id: str
    pair: str
    test_year: int
    config: ModelConfig
    scaler: Scaler
    model: Any
    entry: dict[str, Any]


class Registry:
    def __init__(self, models_dir: Path) -> None:
        manifest_path = models_dir / "manifest.json"
        if not manifest_path.is_file():
            raise RuntimeError(f"{manifest_path} is missing: run the walk-forward training and the report")
        self.manifest: dict[str, Any] = json.loads(manifest_path.read_text(encoding="utf-8"))
        evaluation_path = models_dir / "evaluation.json"
        self.evaluation: dict[str, Any] = json.loads(evaluation_path.read_text(encoding="utf-8"))
        self.models: dict[tuple[str, int], LoadedModel] = {}
        for e in self.manifest["models"]:
            cfg = ModelConfig("lstm", window=int(e["lstm"]["window"]), hidden=int(e["lstm"]["hidden"]))
            self.models[(e["instrument"], int(e["test_year"]))] = LoadedModel(
                id=e["id"],
                pair=e["pair"],
                test_year=int(e["test_year"]),
                config=cfg,
                scaler=Scaler.from_dict(e["scaler"]),
                model=load_model(cfg, models_dir / e["lstm"]["file"]["path"]),
                entry=e,
            )
        if not self.models:
            raise RuntimeError("the manifest lists no models")

    @property
    def instruments(self) -> list[str]:
        return sorted({k[0] for k in self.models})


def parse_range(start: str, end: str) -> tuple[date, date]:
    try:
        d0, d1 = date.fromisoformat(start), date.fromisoformat(end)
    except ValueError as err:
        raise PredictionError("from and to must be calendar dates (YYYY-MM-DD)", 422) from err
    if len(start) != 10 or len(end) != 10:
        raise PredictionError("from and to must be calendar dates (YYYY-MM-DD)", 422)
    if d0 > d1:
        raise PredictionError("from is after to", 422)
    if (d1 - d0).days + 1 > MAX_DAYS:
        raise PredictionError(f"the range may cover at most {MAX_DAYS} days", 422)
    if d0.year < TEST_YEARS[0] or d1.year > TEST_YEARS[-1]:
        raise PredictionError(
            f"predictions exist only for the walk-forward test years {TEST_YEARS[0]}-{TEST_YEARS[-1]}", 422
        )
    return d0, d1


def direction(bars: Bars, i: int) -> str:
    close2 = int(bars.bid_close[i] + bars.ask_close[i])
    open2 = int(bars.bid_open[i] + bars.ask_open[i])
    return "UP" if close2 > open2 else "DOWN" if close2 < open2 else "FLAT"


def validate(registry: Registry, instrument: str, start: str, end: str) -> tuple[date, date]:
    """Checks a request before any database access."""
    if instrument not in registry.instruments:
        raise PredictionError(f"no models for {instrument}", 404)
    return parse_range(start, end)


def mid_ohlc(bars: Bars, i: int, scale: float) -> dict[str, float]:
    """The target bar's mid OHLC as prices (for display; the model works in points)."""
    return {
        "open": int(bars.bid_open[i] + bars.ask_open[i]) / 2 / scale,
        "high": int(bars.bid_high[i] + bars.ask_high[i]) / 2 / scale,
        "low": int(bars.bid_low[i] + bars.ask_low[i]) / 2 / scale,
        "close": int(bars.bid_close[i] + bars.ask_close[i]) / 2 / scale,
    }


def predict(
    registry: Registry, conn: psycopg.Connection[tuple[object, ...]], instrument: str, start: str, end: str
) -> list[dict[str, Any]]:
    """One prediction per H1 target bar starting within [from 00:00, to + 1 day 00:00) UTC."""
    d0, d1 = validate(registry, instrument, start, end)
    lo = datetime(d0.year, d0.month, d0.day, tzinfo=UTC)
    hi = datetime(d1.year, d1.month, d1.day, tzinfo=UTC) + timedelta(days=1)
    pair = instrument.replace("_", "/")
    try:
        bars = read_bars(conn, pair, lo - LOOKBACK, hi)
    except ValueError as err:
        raise PredictionError(str(err), 404) from err
    scale = 10.0 ** price_decimals(conn, pair)
    features = bar_features(bars)
    targets = next_bar_targets(bars)
    lo_s, hi_s = int(lo.timestamp()), int(hi.timestamp())
    # decision bars t whose target bar t+1 starts inside the range
    t_all = np.flatnonzero((bars.time[1:] >= lo_s) & (bars.time[1:] < hi_s)).astype(np.int64)
    out: list[dict[str, Any]] = []
    for year in sorted({datetime.fromtimestamp(int(bars.time[t + 1]), tz=UTC).year for t in t_all}):
        m = registry.models.get((instrument, year))
        if m is None:
            raise PredictionError(f"no model for {instrument} {year}", 404)
        t = np.array(
            [x for x in t_all if datetime.fromtimestamp(int(bars.time[x + 1]), tz=UTC).year == year], dtype=np.int64
        )
        if t.min() < m.config.window:
            raise PredictionError("not enough bars before the range to build a window", 422)
        scaled = m.scaler.transform(features).astype(np.float32)
        p = predict_proba(m.model, scaled, t, m.config.window)
        for k, ti in enumerate(t):
            out.append(
                {
                    "barTime": datetime.fromtimestamp(int(bars.time[ti]), tz=UTC).isoformat().replace("+00:00", "Z"),
                    "targetBarTime": datetime.fromtimestamp(int(bars.time[ti + 1]), tz=UTC)
                    .isoformat()
                    .replace("+00:00", "Z"),
                    "pUp": float(p[k]),
                    "predicted": "UP" if p[k] >= 0.5 else "DOWN",
                    "actual": direction(bars, int(ti + 1)),
                    "bar": mid_ohlc(bars, int(ti + 1), scale),
                    "scored": bool(targets[ti] != NO_TARGET),
                    "model": m.id,
                }
            )
    out.sort(key=lambda r: r["targetBarTime"])
    return out
