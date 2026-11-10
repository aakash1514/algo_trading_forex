"""FastAPI app. Inference only: models are trained offline (ml_service.walk_forward)
and loaded from models/ (manifest.json) at startup.

  GET /health/live, /health/ready          public, for the host's probes (ml_service.health)
  GET /api/ml/health                       public
  GET /api/ml/models                       JWT  the walk-forward models (one per pair and test year)
  GET /api/ml/evaluation                   JWT  pooled tests (Holm), per pair-year metrics, controls
  GET /api/ml/predictions/{instrument}     JWT  ?timeframe=1h&from=YYYY-MM-DD&to=YYYY-MM-DD (inclusive,
                                                <= 31 days, 2016-2022): out-of-sample predictions
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from ml_service.auth import CurrentUser
from ml_service.config import SERVICE_ROOT, get_settings
from ml_service.db import check_db, connect
from ml_service.health import add_health_routes
from ml_service.inference import PredictionError, Registry, predict, validate

API_PREFIX = "/api/ml"
TARGET = "direction of the next H1 bar, mid open to close"
DISCLAIMER = "historical walk-forward test, not live signals"


def models_dir() -> Path:
    return Path(os.environ.get("ML_MODELS_DIR") or SERVICE_ROOT / "models")


def model_summary(e: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": e["id"],
        "instrument": e["instrument"],
        "timeframe": e["timeframe"],
        "testYear": e["test_year"],
        "periods": e["periods"],
        "samples": e["samples"],
        "lstm": {k: e["lstm"][k] for k in ("config", "window", "hidden")} | {"sha256": e["lstm"]["file"]["sha256"]},
        "logistic": {"config": e["logistic"]["config"], "sha256": e["logistic"]["file"]["sha256"]},
        "barsSha256": e["bars_sha256"],
        "test": e["test"],
    }


def create_app(models: Path | None = None) -> FastAPI:
    settings = get_settings()
    registry = Registry(models or models_dir())
    app = FastAPI(title="ForexEdge ML service", docs_url=f"{API_PREFIX}/docs", openapi_url=f"{API_PREFIX}/openapi.json")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_origins),
        allow_credentials=True,
        allow_methods=["GET"],
        allow_headers=["Authorization", "Content-Type"],
    )

    def check_models() -> None:
        if not registry.models:
            raise RuntimeError("no models loaded")

    add_health_routes(app, {"db": check_db, "models": check_models})

    @app.get(f"{API_PREFIX}/health")
    def health() -> dict[str, Any]:
        return {"status": "ok", "models": len(registry.models)}

    @app.get(f"{API_PREFIX}/models")
    def models_list(_: CurrentUser) -> dict[str, Any]:
        return {
            "target": TARGET,
            "disclaimer": DISCLAIMER,
            "generatedAt": registry.manifest["generated_at"],
            "commit": registry.manifest["commit"],
            "lstmGrid": registry.manifest["lstm_grid"],
            "models": [model_summary(e) for e in registry.manifest["models"]],
        }

    @app.get(f"{API_PREFIX}/evaluation")
    def evaluation(_: CurrentUser) -> dict[str, Any]:
        ev = registry.evaluation
        return {
            "target": TARGET,
            "disclaimer": DISCLAIMER,
            "generatedAt": ev["generated_at"],
            "commit": ev["commit"],
            "rule": "LSTM beats a baseline only with higher pooled 2016-2022 accuracy and a McNemar p < 0.05 "
            "after Holm correction across the 16 pooled LSTM-vs-baseline tests",
            "pooled": ev["significance"],
            "perYear": [
                {
                    "instrument": e["instrument"],
                    "testYear": e["test_year"],
                    "chosenLstm": e["lstm"]["config"],
                    "test": e["test"],
                }
                for e in registry.manifest["models"]
            ],
            "controls": ev["controls"],
            "reproducibility": ev["reproducibility"],
            "breakEven": ev["break_even"],
            "sqlCheck": {"pairYears": len(ev["sql_check"]), "allMatch": all(s["match"] for s in ev["sql_check"])},
        }

    @app.get(f"{API_PREFIX}/predictions/{{instrument}}")
    def predictions(
        instrument: str,
        _: CurrentUser,
        start: str = Query(alias="from"),
        end: str = Query(alias="to"),
        timeframe: str = "1h",
    ) -> dict[str, Any]:
        if timeframe != "1h":
            raise HTTPException(status_code=422, detail="only timeframe=1h has models")
        try:
            validate(registry, instrument, start, end)
            with connect() as conn:
                rows = predict(registry, conn, instrument, start, end)
        except PredictionError as err:
            raise HTTPException(status_code=err.status, detail=str(err)) from err
        return {
            "instrument": instrument,
            "timeframe": timeframe,
            "from": start,
            "to": end,
            "target": TARGET,
            "disclaimer": DISCLAIMER,
            "predictions": rows,
        }

    return app


def run() -> None:
    import uvicorn

    uvicorn.run(create_app(), host="0.0.0.0", port=get_settings().port)


if __name__ == "__main__":
    run()
