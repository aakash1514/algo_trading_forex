"""Database access as the read-only login (ML_DB_USER, member of forexedge_readonly).

Defense in depth: the role can only SELECT the history tables, and every session is
also opened with default_transaction_read_only=on."""

from __future__ import annotations

import os
from dataclasses import dataclass

import psycopg

from ml_service.config import REPO_ROOT, load_env_file


@dataclass(frozen=True)
class DbSettings:
    host: str
    port: int
    dbname: str
    user: str
    password: str


def db_settings() -> DbSettings:
    load_env_file(REPO_ROOT / ".env")
    user = os.environ.get("ML_DB_USER")
    password = os.environ.get("ML_DB_PASS")
    if not user or not password:
        raise RuntimeError("ML_DB_USER and ML_DB_PASS must be set (tools/ops/create-ml-db-user.ts)")
    if user == os.environ.get("DB_USER"):
        raise RuntimeError("ML_DB_USER must be the read-only login, not DB_USER")
    return DbSettings(
        host=os.environ.get("DB_HOST") or "localhost",
        port=int(os.environ["DB_PORT"]),
        dbname=os.environ["DB_NAME"],
        user=user,
        password=password,
    )


def connect() -> psycopg.Connection[tuple[object, ...]]:
    s = db_settings()
    return psycopg.connect(
        host=s.host,
        port=s.port,
        dbname=s.dbname,
        user=s.user,
        password=s.password,
        options="-c default_transaction_read_only=on",
        application_name="ml-service",
    )
