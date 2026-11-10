"""The access-token claims checked here must be the ones auth-service signs with
(libs/common/src/lib/jwt-claims.ts), or every request would be refused, or worse, a token
another verifier refuses would pass here."""

from __future__ import annotations

import re

from ml_service.auth import ACCESS_TOKEN_CLAIMS, JWT_ACCESS_AUDIENCE, JWT_ALGORITHM, JWT_ISSUER
from ml_service.config import REPO_ROOT

TS = REPO_ROOT / "libs" / "common" / "src" / "lib" / "jwt-claims.ts"


def ts_constants() -> dict[str, str]:
    found = dict(re.findall(r"^export const (JWT_[A-Z_]+) = '([^']*)';", TS.read_text(encoding="utf-8"), re.M))
    assert len(found) == 4, found  # an empty or partial read must fail, never compare nothing
    return found


def test_the_claims_equal_auth_services() -> None:
    ts = ts_constants()
    ours = {
        "JWT_ALGORITHM": JWT_ALGORITHM,
        "JWT_ISSUER": JWT_ISSUER,
        "JWT_ACCESS_AUDIENCE": JWT_ACCESS_AUDIENCE,
        "claims": ACCESS_TOKEN_CLAIMS,
    }
    expected = {
        "JWT_ALGORITHM": ts["JWT_ALGORITHM"],
        "JWT_ISSUER": ts["JWT_ISSUER"],
        "JWT_ACCESS_AUDIENCE": ts["JWT_ACCESS_AUDIENCE"],
        "claims": {"iss": ts["JWT_ISSUER"], "aud": ts["JWT_ACCESS_AUDIENCE"]},
    }
    assert ours == expected
    assert ts["JWT_REFRESH_AUDIENCE"] not in (ours["JWT_ACCESS_AUDIENCE"], "")
