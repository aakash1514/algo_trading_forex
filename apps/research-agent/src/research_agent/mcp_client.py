"""How the agent starts the MCP server for one request: a child process over stdio, with the
caller's identity in its environment only. The MCP SDK passes a child only a minimal set of the
parent's variables (PATH, HOME, ...), so the settings its tools need are forwarded by name
(CHILD_SETTINGS): the database and its read-only login, and ml-service's URL. In a container they come
from the environment; on a laptop the child also reads the repo .env. Nothing else is forwarded: not
the JWT secret, not the LLM key, not other services' logins."""

from __future__ import annotations

import os
import sys

from mcp.client.stdio import StdioServerParameters

from research_agent.config import SERVICE_ROOT

CHILD_SETTINGS = (
    "DB_HOST",
    "DB_PORT",
    "DB_NAME",
    "DB_USER",  # compared only, never used to connect: the login must differ from the main user
    "ML_DB_USER",
    "RESEARCH_DB_USER",
    "RESEARCH_DB_PASS",
    "ML_SERVICE_URL",
)

TOOL_NAMES = (
    "list_available_data",
    "get_bars",
    "get_market_stats",
    "list_backtest_runs",
    "get_backtest_run",
    "get_ml_evaluation",
    "get_ml_predictions",
)


def server_params(user_id: str, token: str) -> StdioServerParameters:
    return StdioServerParameters(
        command=sys.executable,
        args=["-m", "research_agent.mcp_server"],
        env={
            **{name: os.environ[name] for name in CHILD_SETTINGS if name in os.environ},
            "RESEARCH_USER_ID": user_id,
            "RESEARCH_ML_TOKEN": token,
            "PYTHONPATH": str(SERVICE_ROOT / "src"),
        },
        cwd=SERVICE_ROOT,
    )
