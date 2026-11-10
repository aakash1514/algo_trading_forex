"""Settings from the environment. Like the Node services, the service runs with the
repo root's single .env; variables already in the environment win over the file."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]
SERVICE_ROOT = Path(__file__).resolve().parents[2]


def load_env_file(path: Path) -> None:
    """KEY=VALUE lines; blank lines and # comments skipped; existing variables kept."""
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ.setdefault(key, value)


def cors_origins(dev_default: tuple[str, ...]) -> tuple[str, ...]:
    """CORS_ORIGIN (comma-separated origins), as the Node services read it (libs/common runtime-env.ts):
    required when NODE_ENV=production, the local default otherwise."""
    raw = (os.environ.get("CORS_ORIGIN") or "").strip()
    if not raw:
        if os.environ.get("NODE_ENV") == "production":
            raise RuntimeError("CORS_ORIGIN must be set when NODE_ENV=production")
        return dev_default
    origins = tuple(o.strip() for o in raw.split(",") if o.strip())
    for origin in origins:
        scheme, sep, rest = origin.partition("://")
        if scheme not in ("http", "https") or not sep or not rest or "/" in rest:
            raise RuntimeError(f'CORS_ORIGIN entry "{origin}" must be an origin like https://example.com')
    return origins


@dataclass(frozen=True)
class Settings:
    port: int
    cors_origins: tuple[str, ...]


def get_settings() -> Settings:
    load_env_file(REPO_ROOT / ".env")
    return Settings(
        port=int(os.environ.get("ML_SERVICE_PORT", "3006")),
        cors_origins=cors_origins(("http://localhost:4200", "http://localhost:3001")),
    )
