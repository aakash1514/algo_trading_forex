"""CORS_ORIGIN: the same rule as the Node services (libs/common runtime-env.ts)."""

from __future__ import annotations

import pytest

from ml_service.config import cors_origins

DEV = ("http://localhost:4200",)


def test_production_without_cors_origin_fails_startup(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("NODE_ENV", "production")
    monkeypatch.delenv("CORS_ORIGIN", raising=False)
    with pytest.raises(RuntimeError, match="CORS_ORIGIN must be set"):
        cors_origins(DEV)


def test_configured_origins_replace_the_local_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("NODE_ENV", "production")
    monkeypatch.setenv("CORS_ORIGIN", "https://app.example.test, https://b.example.test")
    assert cors_origins(DEV) == ("https://app.example.test", "https://b.example.test")


def test_development_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("NODE_ENV", raising=False)
    monkeypatch.delenv("CORS_ORIGIN", raising=False)
    assert cors_origins(DEV) == DEV


@pytest.mark.parametrize("bad", ["https://app.example.test/", "app.example.test", "ftp://x.test"])
def test_an_entry_that_is_not_an_origin_fails(monkeypatch: pytest.MonkeyPatch, bad: str) -> None:
    monkeypatch.setenv("CORS_ORIGIN", bad)
    with pytest.raises(RuntimeError):
        cors_origins(DEV)
