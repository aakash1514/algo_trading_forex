"""The JWT dependency on its own (the /ask endpoint is tested with it in test_api.py)."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from research_agent.auth import CurrentUser
from tests.tokens import TEST_USER_ID, auth, invalid_auth_headers, token


def probe_client() -> TestClient:
    app = FastAPI()

    @app.get("/probe")
    def probe(user: CurrentUser) -> dict[str, Any]:
        return {"id": user.id, "email": user.email, "role": user.role, "forwarded": user.token}

    return TestClient(app)


@pytest.mark.parametrize("headers", invalid_auth_headers())
def test_invalid_or_missing_tokens_are_refused(headers: dict[str, str]) -> None:
    r = probe_client().get("/probe", headers=headers)
    assert r.status_code == 401
    assert r.headers["www-authenticate"] == "Bearer"


def test_a_valid_token_yields_the_user_and_keeps_the_token_for_forwarding() -> None:
    t = token()
    r = probe_client().get("/probe", headers=auth(t))
    assert r.status_code == 200
    assert r.json() == {"id": TEST_USER_ID, "email": "research-test@example.com", "role": "TRADER", "forwarded": t}


def test_the_token_never_appears_in_the_users_repr() -> None:
    from research_agent.auth import User

    t = token()
    assert t not in repr(User(id=TEST_USER_ID, email=None, role=None, token=t))
