"""Settings from the environment. Like the Node services and ml-service, the service runs
with the repo root's single .env; variables already in the environment win over the file."""

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


@dataclass(frozen=True)
class Settings:
    port: int
    cors_origins: tuple[str, ...]


def get_settings() -> Settings:
    load_env_file(REPO_ROOT / ".env")
    return Settings(
        port=int(os.environ.get("RESEARCH_AGENT_PORT", "3007")),
        # the frontend only (not Grafana's 3001); the browser sends the access token as a bearer header
        cors_origins=("http://localhost:4200",),
    )
