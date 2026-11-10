"""Records real LLM transcripts for the agent tests (tests/fixtures/transcripts/).

Runs the real agent (model from RESEARCH_LLM_MODEL, default Groq gpt-oss-120b; uses free-tier
quota) on each scenario and keeps only what the model said: each reply's text, its tool calls
(provider ids renamed tc_1, tc_2, ...; claims cite the agent's own call_N ids) and its token
counts. No response metadata, provider request ids, keys or headers are written. The final
report and run stats are kept for reference. ml-service and the database must be up; the
research_demo user's runs must exist (README: Recreate research demo data).

    .venv/Scripts/python.exe scripts/record_transcripts.py [scenario ...]
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import jwt
from langchain_core.messages import AIMessage

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from research_agent.agent import DEFAULT_MODEL, ResearchAgent, RunStats
from research_agent.auth import ACCESS_TOKEN_CLAIMS, access_secret
from research_agent.db import connect

OUT = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "transcripts"
DEMO_RUN = "29f80e07-73df-473d-9621-948797c8f9e0"  # research_demo's EUR/USD 2022 run

SCENARIOS: dict[str, str] = {
    "eurusd-2022": "How did EUR/USD do in 2022 on daily bars? Give the return and the maximum drawdown.",
    "buy-sell": "Should I buy EUR/USD now? Give me a buy or sell signal.",
    "out-of-range": "What was the EUR/USD return in 2023?",
    "other-pair": "How did AUD/USD perform in 2020?",
    "backtest": "Summarise my USD/JPY backtest run: net result in USD, win rate and maximum drawdown.",
    "ml-gbpusd": "Is the GBP/USD LSTM model tradable? What accuracy did it reach compared with the break-even?",
    "difference": "What is the difference between the 2022 returns of EUR/USD and GBP/USD on daily bars?",
}


def sanitize(messages: list[AIMessage]) -> list[dict[str, Any]]:
    ids: dict[str, str] = {}
    for m in messages:
        for tc in m.tool_calls:
            ids.setdefault(str(tc["id"]), f"tc_{len(ids) + 1}")

    def rename(v: Any) -> Any:
        if isinstance(v, str):
            return ids.get(v, v)
        if isinstance(v, list):
            return [rename(x) for x in v]
        if isinstance(v, dict):
            return {k: rename(x) for k, x in v.items()}
        return v

    out = []
    for m in messages:
        usage: dict[str, Any] = dict(m.usage_metadata or {})
        out.append(
            {
                "content": m.content if isinstance(m.content, str) else "",
                "tool_calls": [
                    {"id": ids[str(tc["id"])], "name": tc["name"], "args": rename(tc["args"])} for tc in m.tool_calls
                ],
                "usage": {k: int(usage.get(k, 0)) for k in ("input_tokens", "output_tokens", "total_tokens")},
            }
        )
    return out


async def record(name: str, question: str, user_id: str) -> None:
    now = int(time.time())
    token = jwt.encode(
        {**ACCESS_TOKEN_CLAIMS, "sub": user_id, "role": "TRADER", "iat": now, "exp": now + 600},
        access_secret(),
        "HS256",
    )
    replies: list[AIMessage] = []
    stats = RunStats()
    report = await ResearchAgent(recorder=replies).ask(question, user_id, token, stats)
    doc = {
        "question": question,
        "user": "research_demo",
        "model": DEFAULT_MODEL,
        "recorded_at": datetime.now(UTC).date().isoformat(),
        "replies": sanitize(replies),
        "report": json.loads(report.model_dump_json()),
        "stats": asdict(stats),
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"{name}.json").write_text(json.dumps(doc, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(
        f"{name}: {report.type}, verified={report.verification.ok}, model calls {stats.model_calls}, "
        f"tool calls {stats.tool_calls}, tokens {stats.total_tokens}, {stats.wall_s:.1f} s, {stats.stop_reason}"
    )


async def main(names: list[str]) -> None:
    with connect() as conn:
        row = conn.execute("SELECT user_id FROM backtest_runs WHERE id = %s", (DEMO_RUN,)).fetchone()
    if row is None:
        raise SystemExit("research demo data missing (README: Recreate research demo data)")
    for name in names or list(SCENARIOS):
        await record(name, SCENARIOS[name], str(row[0]))


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1:]))
