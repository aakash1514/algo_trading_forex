from fastapi.testclient import TestClient

from research_agent.main import create_app

FRONTEND = "http://localhost:4200"
DENIED = ("http://localhost:3001", "http://evil.example")


def test_health_is_public() -> None:
    r = TestClient(create_app()).get("/api/research/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_cors_allows_only_the_frontend_with_credentials() -> None:
    r = TestClient(create_app()).get("/api/research/health", headers={"Origin": FRONTEND})
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] == FRONTEND
    assert r.headers["access-control-allow-credentials"] == "true"


def test_cors_preflight_for_ask_from_the_frontend() -> None:
    r = TestClient(create_app()).options(
        "/api/research/ask",
        headers={
            "Origin": FRONTEND,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization,content-type",
        },
    )
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] == FRONTEND
    assert r.headers["access-control-allow-credentials"] == "true"
    assert "POST" in r.headers["access-control-allow-methods"]
    allowed = {h.strip().lower() for h in r.headers["access-control-allow-headers"].split(",")}
    assert {"authorization", "content-type"} <= allowed


def test_cors_denies_other_origins_and_never_uses_a_wildcard() -> None:
    client = TestClient(create_app())
    checked = 0
    for origin in DENIED:
        r = client.get("/api/research/health", headers={"Origin": origin})
        assert r.status_code == 200
        assert "access-control-allow-origin" not in r.headers
        pre = client.options(
            "/api/research/ask",
            headers={
                "Origin": origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "authorization",
            },
        )
        assert pre.status_code == 400
        assert pre.headers.get("access-control-allow-origin") not in (origin, "*")
        checked += 1
    assert checked == len(DENIED) > 0
