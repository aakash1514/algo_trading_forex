"""FastAPI app for the research agent. Stateless: one question in, one structured report out.

GET  /api/research/health    public
POST /api/research/ask       JWT  {"question": "..."} -> report.Report
"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI
from pydantic import BaseModel, ConfigDict, Field

from research_agent.agent import ResearchAgent
from research_agent.auth import CurrentUser
from research_agent.config import get_settings
from research_agent.report import Report

API_PREFIX = "/api/research"


class AskRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    question: str = Field(min_length=3, max_length=500)


def create_app(agent: ResearchAgent | None = None) -> FastAPI:
    research = agent or ResearchAgent()
    app = FastAPI(
        title="ForexEdge research agent", docs_url=f"{API_PREFIX}/docs", openapi_url=f"{API_PREFIX}/openapi.json"
    )

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
