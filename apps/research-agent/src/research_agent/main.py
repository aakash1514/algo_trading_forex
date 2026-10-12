"""FastAPI app for the research agent.

GET  /api/research/health    public
"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI

from research_agent.config import get_settings

API_PREFIX = "/api/research"


def create_app() -> FastAPI:
    app = FastAPI(
        title="ForexEdge research agent", docs_url=f"{API_PREFIX}/docs", openapi_url=f"{API_PREFIX}/openapi.json"
    )

    @app.get(f"{API_PREFIX}/health")
    def health() -> dict[str, Any]:
        return {"status": "ok"}

    return app


def run() -> None:
    import uvicorn

    uvicorn.run(create_app(), host="0.0.0.0", port=get_settings().port)


if __name__ == "__main__":
    run()
