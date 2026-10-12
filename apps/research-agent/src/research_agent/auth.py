"""JWT validation for the research endpoints, matching ml-service, order-service and ws-gateway:
a Bearer access token from auth-service, HS256 with the shared JWT_ACCESS_SECRET, expiry
enforced, and a token without a subject rejected. No token is issued here.

The caller's own token is kept (never printed: repr=False) because the ML tools forward it
to ml-service unchanged; the service holds no credential of its own for ml-service."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Annotated

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from research_agent.config import REPO_ROOT, load_env_file

_bearer = HTTPBearer(auto_error=False)


@dataclass(frozen=True)
class User:
    id: str
    email: str | None
    role: str | None
    token: str = field(repr=False)


def access_secret() -> str:
    load_env_file(REPO_ROOT / ".env")
    secret = os.environ.get("JWT_ACCESS_SECRET")
    if not secret:
        raise RuntimeError("JWT_ACCESS_SECRET is not set")
    return secret


def _unauthorized(detail: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED, detail=detail, headers={"WWW-Authenticate": "Bearer"}
    )


def current_user(credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)]) -> User:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise _unauthorized("Missing bearer token")
    try:
        payload = jwt.decode(
            credentials.credentials, access_secret(), algorithms=["HS256"], options={"require": ["exp", "sub"]}
        )
    except jwt.PyJWTError as err:
        raise _unauthorized("Invalid or expired token") from err
    sub = payload.get("sub")
    if not isinstance(sub, str) or not sub.strip():
        raise _unauthorized("Missing authenticated user id")
    email, role = payload.get("email"), payload.get("role")
    return User(
        id=sub,
        email=email if isinstance(email, str) else None,
        role=role if isinstance(role, str) else None,
        token=credentials.credentials,
    )


CurrentUser = Annotated[User, Depends(current_user)]
