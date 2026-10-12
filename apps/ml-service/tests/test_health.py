from fastapi.testclient import TestClient

from ml_service.config import SERVICE_ROOT
from ml_service.main import create_app


def test_cors_allows_the_frontend_origin() -> None:
    client = TestClient(create_app(SERVICE_ROOT / "models"))
    response = client.get("/api/ml/health", headers={"Origin": "http://localhost:4200"})
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://localhost:4200"
