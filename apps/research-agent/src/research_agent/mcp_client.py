"""How the agent starts the MCP server for one request: a child process over stdio, with the
caller's identity in its environment only. The child also reads the repo .env (DB login, ML URL)
itself, like every service; the MCP SDK passes it only a minimal set of the parent's variables."""

from __future__ import annotations

import sys

from mcp.client.stdio import StdioServerParameters

from research_agent.config import SERVICE_ROOT

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
        env={"RESEARCH_USER_ID": user_id, "RESEARCH_ML_TOKEN": token, "PYTHONPATH": str(SERVICE_ROOT / "src")},
        cwd=SERVICE_ROOT,
    )
