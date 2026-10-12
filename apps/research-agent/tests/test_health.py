from fastapi.testclient import TestClient

from research_agent.main import create_app


def test_health_is_public() -> None:
    r = TestClient(create_app()).get("/api/research/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_no_cors_headers_are_sent_there_is_no_browser_client() -> None:
    r = TestClient(create_app()).get("/api/research/health", headers={"Origin": "http://localhost:4200"})
    assert "access-control-allow-origin" not in r.headers
