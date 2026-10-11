"""FastAPI app. Inference only: models are trained offline (ml_service.training)."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from ml_service.config import get_settings

API_PREFIX = "/api/ml"


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title="ForexEdge ML service", docs_url=f"{API_PREFIX}/docs", openapi_url=f"{API_PREFIX}/openapi.json")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_origins),
        allow_credentials=True,
        allow_methods=["GET"],
        allow_headers=["Authorization", "Content-Type"],
    )

    @app.get(f"{API_PREFIX}/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()


def run() -> None:
    import uvicorn

    settings = get_settings()
    uvicorn.run("ml_service.main:app", host="0.0.0.0", port=settings.port)


if __name__ == "__main__":
    run()
