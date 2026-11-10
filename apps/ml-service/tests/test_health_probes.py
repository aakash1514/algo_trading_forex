"""/health/live and /health/ready (the host's probes): public, outside the API prefix, and a 503
that names the failing dependency only."""

from __future__ import annotations

import threading
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from ml_service import main
from ml_service.health import HealthRunner, add_health_routes

SECRET_ERROR = 'password authentication failed for user "x" at db.internal:5432'


def failing() -> None:
    raise RuntimeError(SECRET_ERROR)


def test_live_and_ready_with_every_check_ok() -> None:
    app = FastAPI()
    add_health_routes(app, {"db": lambda: None})
    client = TestClient(app)
    assert client.get("/health/live").json() == {"status": "ok"}
    r = client.get("/health/ready")
    assert (r.status_code, r.json()) == (200, {"status": "ok", "checks": {"db": "ok"}})


def test_a_down_dependency_is_503_without_its_error_text() -> None:
    app = FastAPI()
    add_health_routes(app, {"db": failing})
    client = TestClient(app)
    r = client.get("/health/ready")
    assert (r.status_code, r.json()) == (503, {"status": "down", "checks": {"db": "down"}})
    assert "db.internal" not in r.text and "password" not in r.text
    assert client.get("/health/live").status_code == 200


def test_a_hung_check_is_down_after_the_timeout_and_not_started_twice() -> None:
    release = threading.Event()
    started = []

    def hang() -> None:
        started.append(1)
        release.wait(10)

    runner = HealthRunner({"db": hang}, timeout_s=0.2)
    t0 = time.monotonic()
    assert runner.run() == (False, {"db": "down"})
    assert runner.run() == (False, {"db": "down"})
    assert time.monotonic() - t0 < 2
    assert len(started) == 1
    release.set()


def test_an_empty_probe_is_refused() -> None:
    with pytest.raises(ValueError):
        HealthRunner({})


def test_the_app_serves_the_probes_with_its_own_db_check(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(main, "check_db", failing)
    client = TestClient(main.create_app())
    assert client.get("/health/live").status_code == 200
    r = client.get("/health/ready")
    assert r.status_code == 503
    assert r.json()["checks"]["db"] == "down"
