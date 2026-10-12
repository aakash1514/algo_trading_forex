"""Records real tool results for the verifier tests (tests/fixtures/tools/).

Each file is one tool call as the agent logs it: {"id", "name", "args", "result"}. The data and
backtest tools read the dev database as the research login; the ML tool calls a running
ml-service with a token minted from the shared JWT_ACCESS_SECRET (not saved). The backtest result
is research_demo's EUR/USD 2022 run (tools/ops/research-demo-data.ts).

    .venv/Scripts/python.exe scripts/record_tool_fixtures.py
"""

from __future__ import annotations

import json
import sys
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
import jwt

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from research_agent.auth import access_secret
from research_agent.db import connect
from research_agent.domain import ToolError
from research_agent.tools import backtests, data, ml

OUT = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "tools"
DEMO_RUN = "29f80e07-73df-473d-9621-948797c8f9e0"


def main() -> None:
    now = int(time.time())
    claims = {"sub": "aaaaaaaa-0000-4000-8000-000000000005", "role": "TRADER", "iat": now, "exp": now + 300}
    token = jwt.encode(claims, access_secret(), algorithm="HS256")
    OUT.mkdir(parents=True, exist_ok=True)
    with connect() as conn, httpx.Client(base_url=ml.ml_base_url(), timeout=120) as http:
        row = conn.execute("SELECT user_id FROM backtest_runs WHERE id = %s", (DEMO_RUN,)).fetchone()
        if row is None:
            raise SystemExit("research demo data missing (README: Recreate research demo data)")
        user = str(row[0])
        client = ml.MlClient(http=http, token=token)
        calls: dict[str, tuple[str, dict[str, Any], Callable[[], dict[str, Any]]]] = {
            "stats-eurusd-2022-1d": (
                "get_market_stats",
                {"pair": "EUR/USD", "timeframe": "1d", "from_date": "2022-01-01", "to_date": "2022-12-30"},
                lambda: data.get_market_stats(conn, "EUR/USD", "1d", "2022-01-01", "2022-12-30"),
            ),
            "stats-xauusd-2020-1d": (
                "get_market_stats",
                {"pair": "XAU/USD", "timeframe": "1d", "from_date": "2020-01-01", "to_date": "2020-12-31"},
                lambda: data.get_market_stats(conn, "XAU/USD", "1d", "2020-01-01", "2020-12-31"),
            ),
            "bars-usdjpy-2022-03-1d": (
                "get_bars",
                {"pair": "USD/JPY", "timeframe": "1d", "from_date": "2022-03-07", "to_date": "2022-03-11"},
                lambda: data.get_bars(conn, "USD/JPY", "1d", "2022-03-07", "2022-03-11"),
            ),
            "backtest-demo-eurusd-2022": (
                "get_backtest_run",
                {"run_id": DEMO_RUN},
                lambda: backtests.get_backtest_run(conn, user, DEMO_RUN),
            ),
            "ml-evaluation-eurusd": (
                "get_ml_evaluation",
                {"pair": "EUR/USD"},
                lambda: ml.get_ml_evaluation(client, "EUR/USD"),
            ),
            "error-audusd": (
                "get_bars",
                {"pair": "AUD/USD", "timeframe": "1d", "from_date": "2022-03-07", "to_date": "2022-03-11"},
                lambda: data.get_bars(conn, "AUD/USD", "1d", "2022-03-07", "2022-03-11"),
            ),
        }
        for name, (tool, args, fn) in calls.items():
            try:
                result = fn()
            except ToolError as err:
                result = err.payload()
            record = {"id": f"call_{name}", "name": tool, "args": args, "result": result}
            (OUT / f"{name}.json").write_text(json.dumps(record, indent=1) + "\n", encoding="utf-8")
            print(f"{name}: {tool}")


if __name__ == "__main__":
    main()
