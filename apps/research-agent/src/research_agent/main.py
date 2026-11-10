"""FastAPI app for the research agent. Stateless: one question in, one structured report out.

GET  /health/live, /health/ready   public, for the host's probes (research_agent.health)
GET  /api/research/health    public
POST /api/research/ask       JWT  {"question": "..."} -> report.Report
"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field

from research_agent.agent import ResearchAgent
from research_agent.auth import CurrentUser
from research_agent.config import get_settings
from research_agent.db import check_db
from research_agent.health import add_health_routes
from research_agent.report import Report

API_PREFIX = "/api/research"
# Longest question accepted (Unicode code points, before stripping), to protect the free LLM token quota.
# The frontend checks the same limit (apps/frontend/src/lib/research.ts).
MAX_QUESTION_CHARS = 500


class AskRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    question: str = Field(min_length=3, max_length=MAX_QUESTION_CHARS)


def create_app(agent: ResearchAgent | None = None) -> FastAPI:
    research = agent or ResearchAgent()
    app = FastAPI(
        title="ForexEdge research agent", docs_url=f"{API_PREFIX}/docs", openapi_url=f"{API_PREFIX}/openapi.json"
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(get_settings().cors_origins),
        allow_credentials=True,
        allow_methods=["GET", "POST"],
        allow_headers=["Authorization", "Content-Type"],
    )

    add_health_routes(app, {"db": check_db})

    @app.get(f"{API_PREFIX}/health")
    def health() -> dict[str, Any]:
        return {"status": "ok"}

    @app.post(f"{API_PREFIX}/ask", response_model=Report)
    async def ask(body: AskRequest, user: CurrentUser) -> Report:
        return await research.ask(body.question.strip(), user.id, user.token)

    return app


def run() -> None:
    import uvicorn

    uvicorn.run(create_app(), host="0.0.0.0", port=get_settings().port)


if __name__ == "__main__":
    run()
