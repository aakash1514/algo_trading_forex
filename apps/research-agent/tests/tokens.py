"""Access tokens minted with the shared JWT_ACCESS_SECRET in auth-service's format
(HS256, sub/email/role, exp), so no user is created in the database."""

from __future__ import annotations

import time

import jwt

from research_agent.auth import ACCESS_TOKEN_CLAIMS, access_secret

TEST_USER_ID = "aaaaaaaa-0000-4000-8000-000000000005"
WRONG_KEY = "a-wrong-secret-that-is-long-enough-for-hs256"


def token(**over: object) -> str:
    claims: dict[str, object] = {
        **ACCESS_TOKEN_CLAIMS,
        "sub": TEST_USER_ID,
        "email": "research-test@example.com",
        "role": "TRADER",
        "iat": int(time.time()),
        "exp": int(time.time()) + 600,
    }
    claims.update(over)
    claims = {k: v for k, v in claims.items() if v is not None}
    return jwt.encode(claims, access_secret(), algorithm="HS256")


def auth(t: str | None = None) -> dict[str, str]:
    return {"Authorization": f"Bearer {t or token()}"}


def invalid_auth_headers() -> list[dict[str, str]]:
    """Every way a request must be refused: no header, wrong scheme, not a JWT, wrong key,
    expired, no subject, blank subject, another issuer, a refresh token's audience, no audience."""
    now = int(time.time())
    return [
        {},
        {"Authorization": f"Basic {token()}"},
        auth("not-a-jwt"),
        auth(jwt.encode({**ACCESS_TOKEN_CLAIMS, "sub": TEST_USER_ID, "exp": now + 60}, WRONG_KEY, algorithm="HS256")),
        auth(token(exp=now - 10)),
        auth(token(sub=None)),
        auth(token(sub="  ")),
        auth(token(iss="someone-else")),
        auth(token(aud="forexedge-refresh")),
        auth(token(aud=None)),
    ]
