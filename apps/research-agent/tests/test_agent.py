"""The agent graph with recorded real Groq transcripts replayed as the model (tests/replay.py),
the real MCP server over stdio and the real verifier.

Without flags: refusals, not-in-data answers, every budget, the verification retry and truncation.
RUN_DB_TESTS=true: the data and backtest answers end to end. RUN_LIVE_ML=true: the ML answer."""

from __future__ import annotations

import asyncio
import json
import os
import time
from typing import Any

import pytest

from research_agent.agent import Budgets, ResearchAgent, RunStats, truncate_for_model
from research_agent.config import SERVICE_ROOT
from research_agent.domain import DISCLAIMER
from research_agent.report import Report
from tests.replay import ReplayChatModel, replay, transcript
from tests.tokens import TEST_USER_ID, token

db = pytest.mark.skipif(os.environ.get("RUN_DB_TESTS") != "true", reason="needs RUN_DB_TESTS=true and the dev database")
live = pytest.mark.skipif(os.environ.get("RUN_LIVE_ML") != "true", reason="needs RUN_LIVE_ML=true and ml-service")
TOOL_FIXTURES = SERVICE_ROOT / "tests" / "fixtures" / "tools"
DEMO_RUN = "29f80e07-73df-473d-9621-948797c8f9e0"


def ask(model: ReplayChatModel, question: str, user_id: str = TEST_USER_ID, **budgets: Any) -> tuple[Report, RunStats]:
    stats = RunStats()
    agent = ResearchAgent(llm=model, budgets=Budgets(**budgets))
    report = asyncio.run(agent.ask(question, user_id, token(sub=user_id), stats))
    return report, stats


def run_transcript(name: str, user_id: str = TEST_USER_ID, **budgets: Any) -> tuple[Report, RunStats, dict[str, Any]]:
    t = transcript(name)
    report, stats = ask(replay(name), t["question"], user_id, **budgets)
    return report, stats, t


def demo_user() -> str:
    from research_agent.db import connect

    with connect() as c:
        row = c.execute("SELECT user_id FROM backtest_runs WHERE id = %s", (DEMO_RUN,)).fetchone()
    assert row is not None, "research demo data missing (README: Recreate research demo data)"
    return str(row[0])


# --- behaviour ---------------------------------------------------------------------------


def test_a_buy_or_sell_question_is_refused() -> None:
    report, stats, t = run_transcript("buy-sell")
    assert report.type == "refusal" and report.verification.ok
    assert report.claims == [] and report.tool_calls == []
    assert report.answer == t["report"]["answer"]
    assert report.disclaimer == DISCLAIMER
    assert stats.model_calls == 1 and stats.stop_reason == "verified"


@pytest.mark.parametrize("name", ["out-of-range", "other-pair"])
def test_a_question_outside_the_data_is_not_in_data(name: str) -> None:
    report, _, t = run_transcript(name)
    assert report.type == "not_in_data" and report.verification.ok
    assert report.claims == []
    assert report.answer == t["report"]["answer"]


# --- budgets -----------------------------------------------------------------------------


def test_the_tool_call_cap_stops_the_graph_before_any_tool_runs() -> None:
    report, stats, _ = run_transcript("eurusd-2022", max_tool_calls=0)
    assert report.type == "could_not_verify" and "budget: tool calls" in report.answer
    assert report.tool_calls == [] and report.claims == []
    assert stats.tool_calls == 0 and stats.model_calls == 1


def test_the_model_call_cap_stops_the_graph() -> None:
    report, stats, _ = run_transcript("eurusd-2022", max_model_calls=0)
    assert report.type == "could_not_verify" and "budget: model calls" in report.answer
    assert stats.model_calls == 0


def test_the_recursion_limit_stops_the_graph() -> None:
    # agent -> verify -> respond needs 3 steps
    report, _, _ = run_transcript("buy-sell", recursion_limit=2)
    assert report.type == "could_not_verify" and "budget: recursion limit" in report.answer


def test_the_wall_clock_stops_the_request_and_its_mcp_server() -> None:
    started = time.monotonic()
    report, stats, _ = run_transcript("buy-sell", timeout_s=0.3)
    elapsed = time.monotonic() - started
    assert report.type == "could_not_verify" and "budget: wall clock" in report.answer
    assert stats.stop_reason == "budget: wall clock"
    assert elapsed < 5  # the stdio server is shut down with the cancelled request, not awaited


def test_a_failed_verification_is_retried_once_then_could_not_verify() -> None:
    # The real submit_report reply of the eurusd-2022 transcript, replayed twice without the tool
    # call it cites: the verifier rejects it both times (no such call), so the agent gets one
    # retry with the failures, then answers "could not verify"; the unverified text is never shown.
    t = transcript("eurusd-2022")
    submit = next(r for r in t["replies"] if r["tool_calls"][0]["name"] == "submit_report")
    model = ReplayChatModel(replies=[submit, submit], seen=[])
    report, stats = ask(model, t["question"])
    assert stats.model_calls == 2 and stats.verification_attempts == 2
    assert report.type == "could_not_verify" and "verification failed" in report.answer
    assert t["report"]["answer"] not in report.model_dump_json()
    assert report.claims == []
    feedback = model.seen[1][-1]
    assert str(feedback.content).startswith("Verification failed") and "unknown tool call" in str(feedback.content)


# --- truncation --------------------------------------------------------------------------


def test_a_cut_columnar_result_says_how_many_rows_were_omitted() -> None:
    result = json.loads((TOOL_FIXTURES / "bars-usdjpy-2022-03-1d.json").read_text(encoding="utf-8"))["result"]
    text = json.dumps(result, separators=(",", ":"))
    shown = truncate_for_model(text, len(text) - 40)
    cut = json.loads(shown)
    assert len(cut["rows"]) < len(result["rows"])
    omitted = len(result["rows"]) - len(cut["rows"])
    assert cut["truncated"] == (
        f"truncated: {omitted} of {len(result['rows'])} rows omitted — use get_market_stats or narrow the range"
    )


def test_a_cut_text_result_says_how_many_chars_were_omitted() -> None:
    result = json.loads((TOOL_FIXTURES / "stats-eurusd-2022-1d.json").read_text(encoding="utf-8"))["result"]
    text = json.dumps(result, separators=(",", ":"))
    shown = truncate_for_model(text, 300)
    assert len(shown) <= 300 and shown.endswith("chars omitted — use get_market_stats or narrow the range]")
    assert f"of {len(text)} chars omitted" in shown


def test_a_result_that_fits_is_never_marked() -> None:
    text = (TOOL_FIXTURES / "error-audusd.json").read_text(encoding="utf-8")
    assert truncate_for_model(text, len(text)) == text


# --- end to end with the database / ml-service ---------------------------------------------


@db
@pytest.mark.parametrize("name", ["eurusd-2022", "backtest", "difference"])
def test_recorded_answers_verify_against_the_live_tools(name: str) -> None:
    report, stats, t = run_transcript(name, demo_user())
    assert report.type == "answer" and report.verification.ok, report.verification.failures
    assert report.answer == t["report"]["answer"]
    assert [c.model_dump() for c in report.claims] == t["report"]["claims"]
    assert len(report.claims) > 0 and report.verification.claims_checked == len(report.claims)
    assert [c.name for c in report.tool_calls] == [c["name"] for c in t["report"]["tool_calls"]]
    assert report.data_ranges and report.disclaimer == DISCLAIMER
    assert stats.tool_calls == len(report.tool_calls)


@db
def test_the_backtest_answer_comes_from_the_callers_own_run() -> None:
    report, _, _ = run_transcript("backtest", demo_user())
    run = next(c for c in report.tool_calls if c.name == "get_backtest_run")
    assert run.ok and "e0e18ad4-f22a-442c-8815-ac579e978ea4" in run.result_truncated  # research_demo's USD/JPY run


@db
def test_another_user_gets_no_backtest_answer() -> None:
    # The same recorded replies for a user without runs: the list is empty and the run is
    # NOT_FOUND, so the cited numbers can't be verified
    report, _, _ = run_transcript("backtest", TEST_USER_ID)
    assert report.type == "could_not_verify"
    assert "1485.75" not in report.model_dump_json()


@live
def test_the_ml_answer_verifies() -> None:
    report, _, t = run_transcript("ml-gbpusd")
    assert report.type == "answer" and report.verification.ok, report.verification.failures
    assert report.answer == t["report"]["answer"]
    assert [c.name for c in report.tool_calls] == ["get_ml_evaluation"]
