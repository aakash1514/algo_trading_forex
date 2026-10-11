from fastapi.testclient import TestClient

from ml_service.main import create_app


def test_health_is_public_and_ok() -> None:
    client = TestClient(create_app())
    response = client.get("/api/ml/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_cors_allows_the_frontend_origin() -> None:
    client = TestClient(create_app())
    response = client.get("/api/ml/health", headers={"Origin": "http://localhost:4200"})
    assert response.headers["access-control-allow-origin"] == "http://localhost:4200"
