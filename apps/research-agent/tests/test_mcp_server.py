"""The MCP server over real stdio: a child process per session, as the agent runs it.

Without flags: the tool list and schemas, a refusal that needs no database, and that the server
refuses to start without the caller's identity. RUN_DB_TESTS=true: data and backtest tools equal
the direct function calls. RUN_LIVE_ML=true: the ML tools too (ml-service running)."""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
from typing import Any

import pytest
from mcp import ClientSession
from mcp.client.stdio import stdio_client
from mcp.types import TextContent

from research_agent.config import SERVICE_ROOT
from research_agent.mcp_client import TOOL_NAMES, server_params
from tests.tokens import TEST_USER_ID, token

db = pytest.mark.skipif(os.environ.get("RUN_DB_TESTS") != "true", reason="needs RUN_DB_TESTS=true and the dev database")
# research_demo's EUR/USD 2022 run (docs/validation/research-demo-backtests.md)
DEMO_RUN = "29f80e07-73df-473d-9621-948797c8f9e0"
live = pytest.mark.skipif(os.environ.get("RUN_LIVE_ML") != "true", reason="needs RUN_LIVE_ML=true and ml-service")


async def _session(user_id: str, calls: list[tuple[str, dict[str, Any]]]) -> tuple[list[Any], list[Any]]:
    async with (
        stdio_client(server_params(user_id, token(sub=user_id))) as (read, write),
        ClientSession(read, write) as session,
    ):
        await session.initialize()
        tools = (await session.list_tools()).tools
        results = []
        for name, args in calls:
            r = await session.call_tool(name, args)
            assert not r.isError, r.content
            assert len(r.content) == 1 and isinstance(r.content[0], TextContent)
            results.append(json.loads(r.content[0].text))
        return tools, results


def run(user_id: str, calls: list[tuple[str, dict[str, Any]]]) -> tuple[list[Any], list[Any]]:
    return asyncio.run(_session(user_id, calls))


def test_exactly_the_seven_read_only_tools_are_listed() -> None:
    tools, _ = run(TEST_USER_ID, [])
    assert sorted(t.name for t in tools) == sorted(TOOL_NAMES) and len(tools) == 7
    for t in tools:
        assert t.annotations is not None and t.annotations.readOnlyHint is True
        assert t.annotations.destructiveHint is False
        assert "user_id" not in json.dumps(t.inputSchema) and "token" not in json.dumps(t.inputSchema)
    schema = {t.name: t.inputSchema for t in tools}
    assert schema["get_bars"]["properties"]["pair"]["enum"] == ["EUR/USD", "GBP/USD", "USD/JPY", "XAU/USD"]
    assert schema["get_market_stats"]["properties"]["timeframe"]["enum"] == ["1h", "4h", "1d"]
    assert schema["get_bars"]["required"] == ["pair", "timeframe", "from_date", "to_date"]


def test_a_refusal_comes_back_as_a_structured_error() -> None:
    _, [out] = run(TEST_USER_ID, [("get_ml_predictions", {"pair": "EUR/USD", "year": 2023})])
    assert out == {
        "error": {
            "code": "OUT_OF_DATA",
            "message": "model predictions exist only for the walk-forward test years 2016-2022",
        }
    }


def test_the_server_refuses_to_start_without_the_callers_identity() -> None:
    env = {k: v for k, v in os.environ.items() if not k.startswith("RESEARCH_")}
    env["PYTHONPATH"] = str(SERVICE_ROOT / "src")
    r = subprocess.run(
        [sys.executable, "-m", "research_agent.mcp_server"], env=env, capture_output=True, text=True, timeout=60
    )
    assert r.returncode != 0
    assert "RESEARCH_USER_ID and RESEARCH_ML_TOKEN must be set" in r.stderr


def _demo_user() -> str:
    from research_agent.db import connect

    with connect() as c:
        row = c.execute("SELECT user_id FROM backtest_runs WHERE id = %s", (DEMO_RUN,)).fetchone()
    assert row is not None, "research demo data missing (README: Recreate research demo data)"
    return str(row[0])


@db
def test_data_and_backtest_tools_equal_the_direct_calls() -> None:
    from research_agent.db import connect
    from research_agent.tools import backtests, data

    user = _demo_user()
    calls: list[tuple[str, dict[str, Any]]] = [
        ("list_available_data", {}),
        ("get_bars", {"pair": "USD/JPY", "timeframe": "1d", "from_date": "2022-03-01", "to_date": "2022-03-31"}),
        (
            "get_market_stats",
            {"pair": "XAU/USD", "timeframe": "4h", "from_date": "2021-01-01", "to_date": "2021-12-31"},
        ),
        ("list_backtest_runs", {}),
        ("get_backtest_run", {"run_id": DEMO_RUN}),
    ]
    _, results = run(user, calls)
    with connect() as c:
        direct = [
            data.list_available_data(c),
            data.get_bars(c, "USD/JPY", "1d", "2022-03-01", "2022-03-31"),
            data.get_market_stats(c, "XAU/USD", "4h", "2021-01-01", "2021-12-31"),
            backtests.list_backtest_runs(c, user),
            backtests.get_backtest_run(c, user, DEMO_RUN),
        ]
    assert results == json.loads(json.dumps(direct))
    assert results[3]["runs_count"] == 3


@db
def test_the_server_scopes_backtests_to_its_user() -> None:
    _, [listed, got] = run(
        TEST_USER_ID,
        [("list_backtest_runs", {}), ("get_backtest_run", {"run_id": DEMO_RUN})],
    )
    assert listed["runs"] == [] and listed["runs_count"] == 0
    assert got["error"]["code"] == "NOT_FOUND"


@live
def test_ml_tools_equal_the_direct_calls() -> None:
    import httpx

    from research_agent.tools import ml

    _, results = run(
        TEST_USER_ID,
        [
            ("get_ml_evaluation", {"pair": "GBP/USD"}),
            ("get_ml_predictions", {"pair": "GBP/USD", "year": 2019, "month": 6}),
        ],
    )
    with httpx.Client(base_url=ml.ml_base_url(), timeout=120) as http:
        client = ml.MlClient(http=http, token=token())
        direct = [ml.get_ml_evaluation(client, "GBP/USD"), ml.get_ml_predictions(client, "GBP/USD", 2019, 6)]
    assert results == json.loads(json.dumps(direct))
