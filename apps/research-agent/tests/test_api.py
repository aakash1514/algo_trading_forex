"""POST /api/research/ask: auth, request validation, and that no secret is ever in a response.
The agent runs with a recorded real transcript replayed as the model (tests/replay.py)."""

from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient

from research_agent.agent import ResearchAgent
from research_agent.config import REPO_ROOT, load_env_file
from research_agent.main import create_app
from tests.replay import replay, transcript
from tests.tokens import auth, invalid_auth_headers, token

ASK = "/api/research/ask"


def client(name: str = "buy-sell") -> TestClient:
    return TestClient(create_app(ResearchAgent(llm=replay(name))))


@pytest.mark.parametrize("headers", invalid_auth_headers())
def test_ask_refuses_missing_or_invalid_tokens(headers: dict[str, str]) -> None:
    r = client().post(ASK, json={"question": "Should I buy EUR/USD now?"}, headers=headers)
    assert r.status_code == 401


@pytest.mark.parametrize(
    "body",
    [{}, {"question": ""}, {"question": "x" * 501}, {"question": "ok?", "user_id": "someone-else"}, {"q": "hi"}],
)
def test_ask_validates_the_request(body: dict[str, object]) -> None:
    assert client().post(ASK, json=body, headers=auth()).status_code == 422


def test_ask_returns_the_structured_report_and_no_secret() -> None:
    t = transcript("buy-sell")
    tok = token()
    r = client("buy-sell").post(ASK, json={"question": t["question"]}, headers=auth(tok))
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"type", "answer", "claims", "tool_calls", "data_ranges", "disclaimer", "verification"}
    assert body["type"] == "refusal" and body["verification"]["ok"] is True
    assert body["answer"] == t["report"]["answer"]
    load_env_file(REPO_ROOT / ".env")
    secrets = [tok] + [
        os.environ[k] for k in ("JWT_ACCESS_SECRET", "GROQ_API_KEY", "RESEARCH_DB_PASS") if os.environ.get(k)
    ]
    assert len(secrets) >= 2
    for s in secrets:
        assert s not in r.text
