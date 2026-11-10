"""Database access as the research login (RESEARCH_DB_USER, member of forexedge_readonly and
forexedge_research_reader).

Defense in depth: the roles can only SELECT the history and some backtest_runs columns, and
every session is also opened with default_transaction_read_only=on."""

from __future__ import annotations

import os
from dataclasses import dataclass

import psycopg

from research_agent.config import REPO_ROOT, load_env_file


@dataclass(frozen=True)
class DbSettings:
    host: str
    port: int
    dbname: str
    user: str
    password: str


def db_settings() -> DbSettings:
    load_env_file(REPO_ROOT / ".env")
    user = os.environ.get("RESEARCH_DB_USER")
    password = os.environ.get("RESEARCH_DB_PASS")
    if not user or not password:
        raise RuntimeError("RESEARCH_DB_USER and RESEARCH_DB_PASS must be set (tools/ops/create-research-db-user.ts)")
    if user in (os.environ.get("DB_USER"), os.environ.get("ML_DB_USER")):
        raise RuntimeError("RESEARCH_DB_USER must be the research login, not DB_USER or ML_DB_USER")
    return DbSettings(
        host=os.environ.get("DB_HOST") or "localhost",
        port=int(os.environ["DB_PORT"]),
        dbname=os.environ["DB_NAME"],
        user=user,
        password=password,
    )


def connect(connect_timeout: int | None = None) -> psycopg.Connection[tuple[object, ...]]:
    s = db_settings()
    return psycopg.connect(
        connect_timeout=connect_timeout,
        host=s.host,
        port=s.port,
        dbname=s.dbname,
        user=s.user,
        password=s.password,
        options="-c default_transaction_read_only=on",
        application_name="research-agent",
    )


def check_db() -> None:
    """Readiness: the login connects and answers (/health/ready)."""
    with connect(connect_timeout=2) as conn:
        conn.execute("SELECT 1")
