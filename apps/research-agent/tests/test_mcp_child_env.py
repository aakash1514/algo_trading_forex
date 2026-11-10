"""The MCP child gets the settings its tools need from the parent's environment (a container has no
.env file), the caller's identity, and nothing else that is secret."""

from __future__ import annotations

import pytest

from research_agent.mcp_client import CHILD_SETTINGS, server_params

USER = "aaaaaaaa-0000-4000-8000-000000000005"


def test_the_child_gets_the_db_login_and_ml_url_but_no_other_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = {
        "DB_HOST": "timescaledb",
        "DB_PORT": "5432",
        "DB_NAME": "forexedge",
        "RESEARCH_DB_USER": "forexedge_research",
        "RESEARCH_DB_PASS": "research-pass",
        "ML_SERVICE_URL": "http://ml-service:3006/api/ml",
    }
    secrets = {"JWT_ACCESS_SECRET": "jwt", "GROQ_API_KEY": "llm", "DB_PASS": "main-db", "REDIS_PASS": "redis"}
    for name, value in {**settings, **secrets}.items():
        monkeypatch.setenv(name, value)
    env = server_params(USER, "caller-token").env
    assert env is not None
    for name, value in settings.items():
        assert env[name] == value
    assert env["RESEARCH_USER_ID"] == USER and env["RESEARCH_ML_TOKEN"] == "caller-token"
    assert not set(secrets) & set(env)
    assert set(env) <= {*CHILD_SETTINGS, "RESEARCH_USER_ID", "RESEARCH_ML_TOKEN", "PYTHONPATH"}
