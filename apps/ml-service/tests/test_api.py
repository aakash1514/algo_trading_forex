"""The inference API on the committed walk-forward models (models/manifest.json).

Tokens are minted here with the shared JWT_ACCESS_SECRET in auth-service's format
(HS256, sub/email/role, exp), so no user is created in the database."""

from __future__ import annotations

import os
import time
from collections.abc import Iterator
from datetime import UTC, datetime

import jwt
import numpy as np
import pytest
from fastapi.testclient import TestClient

from ml_service.auth import ACCESS_TOKEN_CLAIMS, access_secret
from ml_service.config import SERVICE_ROOT
from ml_service.main import create_app

MODELS = SERVICE_ROOT / "models"
PAIRS = ("EUR_USD", "GBP_USD", "USD_JPY", "XAU_USD")
# One test month per pair (each in a different test year), for the offline parity check
PARITY_MONTHS = {
    "EUR_USD": ("2022-03-01", "2022-03-31"),
    "GBP_USD": ("2019-06-01", "2019-06-30"),
    "USD_JPY": ("2020-03-01", "2020-03-31"),
    "XAU_USD": ("2017-10-01", "2017-10-31"),
}
db = pytest.mark.skipif(os.environ.get("RUN_DB_TESTS") != "true", reason="needs RUN_DB_TESTS=true and the dev database")


def token(**over: object) -> str:
    claims: dict[str, object] = {
        **ACCESS_TOKEN_CLAIMS,
        "sub": "aaaaaaaa-0000-4000-8000-000000000001",
        "email": "ml-test@example.com",
        "role": "TRADER",
        "iat": int(time.time()),
        "exp": int(time.time()) + 600,
    }
    claims.update(over)
    claims = {k: v for k, v in claims.items() if v is not None}
    return jwt.encode(claims, access_secret(), algorithm="HS256")


def auth(t: str | None = None) -> dict[str, str]:
    return {"Authorization": f"Bearer {t or token()}"}


@pytest.fixture(scope="module")
def client() -> Iterator[TestClient]:
    with TestClient(create_app(MODELS)) as c:
        yield c


def test_health_is_public_and_counts_the_models(client: TestClient) -> None:
    r = client.get("/api/ml/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "models": 28}


@pytest.mark.parametrize(
    "path", ["/api/ml/models", "/api/ml/evaluation", "/api/ml/predictions/EUR_USD?from=2022-03-01&to=2022-03-02"]
)
def test_every_data_endpoint_needs_a_valid_token(client: TestClient, path: str) -> None:
    assert client.get(path).status_code == 401
    assert client.get(path, headers=auth("not-a-jwt")).status_code == 401
    assert (
        client.get(
            path,
            headers=auth(
                jwt.encode(
                    {**ACCESS_TOKEN_CLAIMS, "sub": "x", "exp": int(time.time()) + 60},
                    "a-wrong-secret-that-is-long-enough-for-hs256",
                )
            ),
        ).status_code
        == 401
    )
    assert client.get(path, headers=auth(token(exp=int(time.time()) - 10))).status_code == 401  # expired
    assert client.get(path, headers=auth(token(sub=None))).status_code == 401  # no subject
    assert client.get(path, headers=auth(token(sub="  "))).status_code == 401
    assert client.get(path, headers=auth(token(iss="someone-else"))).status_code == 401
    assert client.get(path, headers=auth(token(aud="forexedge-refresh"))).status_code == 401  # a refresh token
    assert client.get(path, headers=auth(token(aud=None))).status_code == 401


def test_models_lists_one_model_per_pair_and_test_year(client: TestClient) -> None:
    body = client.get("/api/ml/models", headers=auth()).json()
    assert body["disclaimer"] == "historical walk-forward test, not live signals"
    keys = sorted((m["instrument"], m["testYear"]) for m in body["models"])
    assert keys == sorted((p, y) for p in PAIRS for y in range(2016, 2023))
    for m in body["models"]:
        assert m["lstm"]["window"] == 32 and m["lstm"]["hidden"] in (32, 64)
        assert len(m["lstm"]["sha256"]) == 64
        assert m["samples"]["test"] == m["test"]["lstm"]["n"] > 0


def test_evaluation_has_the_16_pooled_tests_and_every_pair_year(client: TestClient) -> None:
    body = client.get("/api/ml/evaluation", headers=auth()).json()
    assert len(body["pooled"]) == 16
    assert {(r["pair"], r["baseline"]) for r in body["pooled"]} == {
        (p.replace("_", "/"), b) for p in PAIRS for b in ("logistic", "majority", "persistence", "anti_persistence")
    }
    for r in body["pooled"]:
        assert 0 <= r["p_raw"] <= r["p_holm"] <= 1
    assert len(body["perYear"]) == 28
    assert body["sqlCheck"] == {"pairYears": 28, "allMatch": True}
    assert body["reproducibility"]["state_dict_equal"] is True


@pytest.mark.parametrize(
    ("query", "status"),
    [
        ("from=2022-03-01&to=2022-04-02", 422),  # 33 days
        ("from=2015-12-01&to=2015-12-31", 422),  # before the test years
        ("from=2023-01-02&to=2023-01-03", 422),  # after them
        ("from=2022-03-05&to=2022-03-01", 422),  # from after to
        ("from=2022-02-30&to=2022-03-01", 422),  # not a calendar date
        ("from=2022-03-01T00:00Z&to=2022-03-02", 422),  # a timestamp
        ("from=2022-03-01&to=2022-03-02&timeframe=4h", 422),
    ],
)
def test_bad_ranges_are_rejected_before_the_database(client: TestClient, query: str, status: int) -> None:
    assert client.get(f"/api/ml/predictions/EUR_USD?{query}", headers=auth()).status_code == status


def test_an_unknown_instrument_is_404(client: TestClient) -> None:
    r = client.get("/api/ml/predictions/EUR_GBP?from=2022-03-01&to=2022-03-02", headers=auth())
    assert r.status_code == 404


@db
@pytest.mark.parametrize("instrument", PAIRS)
def test_predictions_equal_the_offline_walk_forward_run(client: TestClient, instrument: str) -> None:
    start, end = PARITY_MONTHS[instrument]
    body = client.get(f"/api/ml/predictions/{instrument}?from={start}&to={end}", headers=auth()).json()
    rows = body["predictions"]
    year = int(start[:4])
    offline = np.load(MODELS / f"{instrument.replace('_', '')}-1h-test{year}-test.npz")
    lo = int(datetime.fromisoformat(start).replace(tzinfo=UTC).timestamp())
    hi = int(datetime.fromisoformat(end).replace(tzinfo=UTC).timestamp()) + 86400
    month = (offline["target_time"] >= lo) & (offline["target_time"] < hi)
    expected = {int(t): float(p) for t, p in zip(offline["target_time"][month], offline["p_lstm"][month], strict=True)}
    assert len(expected) > 300
    served = {
        int(datetime.fromisoformat(r["targetBarTime"].replace("Z", "+00:00")).timestamp()): r
        for r in rows
        if r["scored"]
    }
    assert served.keys() == expected.keys()  # the same scored samples
    for ts, p in expected.items():
        assert abs(served[ts]["pUp"] - p) <= 1e-6, ts
        assert served[ts]["predicted"] == ("UP" if p >= 0.5 else "DOWN")
        assert served[ts]["model"] == f"{instrument}-1h-test{year}"
