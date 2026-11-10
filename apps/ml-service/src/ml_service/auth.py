"""JWT validation for the ML endpoints, matching order-service and ws-gateway: a Bearer
access token from auth-service, HS256 with the shared JWT_ACCESS_SECRET, expiry enforced,
and a token without a subject rejected. No token is issued here."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Annotated

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from ml_service.config import REPO_ROOT, load_env_file

_bearer = HTTPBearer(auto_error=False)

# The claims auth-service puts in an access token, as in libs/common/src/lib/jwt-claims.ts (a test
# keeps the two equal). A refresh token (audience forexedge-refresh) is refused here.
JWT_ALGORITHM = "HS256"
JWT_ISSUER = "forexedge-auth"
JWT_ACCESS_AUDIENCE = "forexedge-api"
ACCESS_TOKEN_CLAIMS = {"iss": JWT_ISSUER, "aud": JWT_ACCESS_AUDIENCE}


@dataclass(frozen=True)
class User:
    id: str
    email: str | None
    role: str | None


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
            credentials.credentials,
            access_secret(),
            algorithms=[JWT_ALGORITHM],
            issuer=JWT_ISSUER,
            audience=JWT_ACCESS_AUDIENCE,
            options={"require": ["exp", "sub", "iss", "aud"]},
        )
    except jwt.PyJWTError as err:
        raise _unauthorized("Invalid or expired token") from err
    sub = payload.get("sub")
    if not isinstance(sub, str) or not sub.strip():
        raise _unauthorized("Missing authenticated user id")
    email, role = payload.get("email"), payload.get("role")
    return User(id=sub, email=email if isinstance(email, str) else None, role=role if isinstance(role, str) else None)


CurrentUser = Annotated[User, Depends(current_user)]
