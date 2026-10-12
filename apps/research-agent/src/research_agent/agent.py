"""The research agent: a LangGraph loop over the MCP tools, then a deterministic verifier.

  agent --(data tool calls)--> tools --> agent
  agent --(submit_report)----> verify --ok--> respond
                                      --fails, first time--> agent (with the failures)
                                      --fails again--> respond (could_not_verify)
  any budget exhausted ------> respond (could_not_verify)

The model must call a tool on every turn (tool_choice="required") and finishes only through
submit_report (report.SubmitReport). An answer is returned only if the verifier passes; otherwise
the response is "could not verify", never the unverified text.

Per-request budgets (Budgets): data-tool calls, model calls (including the one retry), LangGraph
recursion limit, max output tokens per model call, and the wall clock (which also ends the MCP
server process). The model and provider come from the environment only (RESEARCH_LLM_MODEL, read
by LangChain's init_chat_model)."""

from __future__ import annotations

import asyncio
import json
import logging
import operator
import os
import time
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Annotated, Any, Literal, TypedDict

from langchain.chat_models import init_chat_model
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, AnyMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import BaseTool, StructuredTool
from langchain_mcp_adapters.tools import load_mcp_tools
from langgraph.errors import GraphRecursionError
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from mcp import ClientSession
from mcp.client.stdio import stdio_client
from pydantic import ValidationError

from research_agent.config import REPO_ROOT, load_env_file
from research_agent.domain import DISCLAIMER
from research_agent.mcp_client import TOOL_NAMES, server_params
from research_agent.report import (
    Claim,
    DataRange,
    Report,
    SubmitReport,
    ToolCallRecord,
    Verification,
)
from research_agent.verifier import CallResult, verify

log = logging.getLogger("research_agent")

DEFAULT_MODEL = "groq:openai/gpt-oss-120b"
SUBMIT = "submit_report"
TRUNCATE_HINT = "use get_market_stats or narrow the range"


def _squash(text: str) -> str:
    return " ".join(text.split())


INTRO = """You answer questions about ForexEdge's own data only: the Dukascopy history from 2010-01-01 to
2022-12-30 for EUR/USD, GBP/USD, USD/JPY and XAU/USD (1h, 4h and 1d bars), the user's completed backtest runs,
and the LSTM walk-forward evaluation (out-of-sample test years 2016-2022). Use the tools. Every answer, including
a refusal, ends with one call to the submit_report tool (its "type" field is "answer", "refusal" or
"not_in_data"); there are no other tools for answering."""
RULES = (
    """1. Every number you write must be copied from a tool result in this conversation. Never compute, convert,
    average, round further than allowed, estimate or recall a number. If a question needs arithmetic (a difference,
    a sum, an average), answer with the tool values it would use and say that you don't compute derived numbers.""",
    """2. In submit_report add one claim per number in the answer: value exactly as written (with its sign, e.g.
    "-5.86"), unit = the suffix of the source field (price, pips, pct, usd, count, ratio, p, lots, param), and the
    tool_call_id shown at the top of that tool result (e.g. call_1). Prices: write all price_decimals digits.
    Percent, pips, ratios and p-values: keep at least 3 significant digits. Counts and USD: exact. For a negative
    value write the minus sign or say fell/declined/lost/dropped; never rose/gained/up for a negative value or the
    reverse. Write dates as YYYY-MM-DD.""",
    """3. Requests for buy/sell/hold advice, trade signals, forecasts or recommendations: call submit_report with
    type "refusal", a short explanation, no numbers and no claims. Model predictions are a historical test, never
    signals. Reporting the walk-forward evaluation (accuracy, baseline tests, the spread break-even and its
    conclusion on whether the historical results cover the spread) is data, not advice: a question such as "is the
    model tradable / profitable / any good" is answered by calling get_ml_evaluation and reporting its accuracy,
    break-even and conclusion.""",
    """4. Anything the tools don't cover (other pairs, dates outside 2010-01-01 to 2022-12-30, news,
    fundamentals, live prices, economic events): call submit_report with type "not_in_data", no numbers and no
    claims. If a tool returns OUT_OF_DATA, do the same.""",
    """5. Ranges longer than 50 bars: use get_market_stats, not get_bars. Use as few tool calls as you can.""",
)
SYSTEM_PROMPT = _squash(INTRO) + "\n\nRules:\n" + "\n".join(_squash(r) for r in RULES)


@dataclass(frozen=True)
class Budgets:
    max_tool_calls: int = 6
    max_model_calls: int = 7
    recursion_limit: int = 16
    max_output_tokens: int = 1200
    timeout_s: float = 90.0
    tool_result_chars: int = 2500
    log_result_chars: int = 600


@dataclass
class RunStats:
    """What a request used (for the live eval); never includes content or secrets."""

    model_calls: int = 0
    tool_calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    wall_s: float = 0.0
    stop_reason: str = ""
    verification_attempts: int = 0
    verification_failures: list[list[str]] = field(default_factory=list)


class State(TypedDict):
    messages: Annotated[list[AnyMessage], add_messages]
    calls: Annotated[list[CallResult], operator.add]
    submitted: SubmitReport | None
    verification: Verification | None
    retries: int
    stop: str | None  # why the graph stopped early


def llm_from_env(budgets: Budgets) -> BaseChatModel:
    load_env_file(REPO_ROOT / ".env")
    kwargs: dict[str, Any] = {"temperature": 0, "max_tokens": budgets.max_output_tokens, "max_retries": 3}
    effort = os.environ.get("RESEARCH_LLM_REASONING_EFFORT")
    if effort:
        kwargs["reasoning_effort"] = effort
    model = init_chat_model(os.environ.get("RESEARCH_LLM_MODEL") or DEFAULT_MODEL, **kwargs)
    if not isinstance(model, BaseChatModel):
        raise RuntimeError("RESEARCH_LLM_MODEL must name one model")
    return model


def submit_tool() -> BaseTool:
    def _never_called(**_: Any) -> str:
        return ""

    return StructuredTool.from_function(
        func=_never_called,
        name=SUBMIT,
        description="Submit the final answer. Every number in `answer` must also be a claim.",
        args_schema=SubmitReport,
    )


def truncate_for_model(text: str, limit: int) -> str:
    """A tool result as the model sees it: whole if it fits, else cut with an explicit marker
    (rows dropped from a columnar result, or characters), never silently."""
    if len(text) <= limit:
        return text
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        parsed = None
    if isinstance(parsed, dict) and isinstance(parsed.get("rows"), list) and parsed["rows"]:
        rows = parsed["rows"]
        total = len(rows)
        keep = total
        while keep > 0:
            keep -= 1
            cut = dict(parsed, rows=rows[:keep])
            marker = f"truncated: {total - keep} of {total} rows omitted \u2014 {TRUNCATE_HINT}"
            cut["truncated"] = marker
            out = json.dumps(cut, separators=(",", ":"))
            if len(out) <= limit:
                return out
    keep_chars = max(0, limit - 120)
    omitted = len(text) - keep_chars
    return text[:keep_chars] + f" ...[truncated: {omitted} of {len(text)} chars omitted \u2014 {TRUNCATE_HINT}]"


def _ranges(calls: Sequence[CallResult]) -> list[DataRange]:
    out = []
    for c in calls:
        if not c.ok:
            continue
        a = c.args
        out.append(
            DataRange(
                tool=c.name,
                pair=a.get("pair"),
                timeframe=a.get("timeframe"),
                from_date=a.get("from_date"),
                to_date=a.get("to_date"),
                year=a.get("year"),
                month=a.get("month"),
                run_id=a.get("run_id"),
            )
        )
    return out


class ResearchAgent:
    def __init__(
        self,
        llm: BaseChatModel | None = None,
        budgets: Budgets | None = None,
        recorder: list[AIMessage] | None = None,
    ) -> None:
        self.budgets = budgets or Budgets()
        self._llm = llm
        self._recorder = recorder  # scripts/record_transcripts.py keeps the model's replies

    @property
    def llm(self) -> BaseChatModel:
        if self._llm is None:
            self._llm = llm_from_env(self.budgets)
        return self._llm

    def _graph(self, tools: list[BaseTool], stats: RunStats) -> Any:
        b = self.budgets
        by_name = {t.name: t for t in tools}
        model = self.llm.bind_tools([*tools, submit_tool()], tool_choice="required")

        async def agent(state: State) -> dict[str, Any]:
            if stats.model_calls >= b.max_model_calls:
                return {"stop": "budget: model calls"}
            stats.model_calls += 1
            msg = await model.ainvoke(state["messages"])
            if self._recorder is not None and isinstance(msg, AIMessage):
                self._recorder.append(msg)
            usage = getattr(msg, "usage_metadata", None) or {}
            stats.input_tokens += int(usage.get("input_tokens", 0))
            stats.output_tokens += int(usage.get("output_tokens", 0))
            stats.total_tokens += int(usage.get("total_tokens", 0))
            return {"messages": [msg]}

        def after_agent(state: State) -> Literal["tools", "verify", "respond"]:
            if state.get("stop"):
                return "respond"
            last = state["messages"][-1]
            calls = last.tool_calls if isinstance(last, AIMessage) else []
            if not calls:
                return "respond"
            return "verify" if any(c["name"] == SUBMIT for c in calls) else "tools"

        async def run_tools(state: State) -> dict[str, Any]:
            last = state["messages"][-1]
            assert isinstance(last, AIMessage)
            if stats.tool_calls + len(last.tool_calls) > b.max_tool_calls:
                return {"stop": "budget: tool calls"}
            messages: list[AnyMessage] = []
            results: list[CallResult] = []
            for tc in last.tool_calls:
                stats.tool_calls += 1
                tool = by_name.get(tc["name"])
                if tool is None or tc["name"] not in TOOL_NAMES:
                    text = json.dumps({"error": {"code": "INVALID_ARGUMENT", "message": f"no tool {tc['name']}"}})
                else:
                    raw = await tool.ainvoke(tc["args"])
                    text = raw if isinstance(raw, str) else _content_text(raw)
                try:
                    parsed = json.loads(text)
                except json.JSONDecodeError:
                    parsed = {"error": {"code": "INVALID_ARGUMENT", "message": text[:300]}}
                # Our own id, shown to the model at the top of the result (models don't see provider
                # tool-call ids); claims cite it and the verifier checks against it
                call_id = f"call_{stats.tool_calls}"
                results.append(CallResult(id=call_id, name=tc["name"], args=dict(tc["args"]), result=parsed))
                shown = f"tool_call_id: {call_id}\n{truncate_for_model(text, b.tool_result_chars)}"
                messages.append(ToolMessage(content=shown, tool_call_id=str(tc["id"])))
            return {"messages": messages, "calls": results}

        def check(state: State) -> dict[str, Any]:
            last = state["messages"][-1]
            assert isinstance(last, AIMessage)
            tc = next(c for c in last.tool_calls if c["name"] == SUBMIT)
            stats.verification_attempts += 1
            submitted: SubmitReport | None = None
            try:
                submitted = SubmitReport.model_validate(tc["args"])
            except ValidationError as err:
                failures = [f"submit_report arguments invalid: {e['loc']}: {e['msg']}" for e in err.errors()]
                verification = Verification(ok=False, failures=failures, claims_checked=0, numbers_checked=0)
            else:
                verification = verify(submitted.type, submitted.answer, submitted.claims, state["calls"])
            if not verification.ok:
                stats.verification_failures.append(verification.failures)
            update: dict[str, Any] = {"submitted": submitted, "verification": verification}
            if not verification.ok and state["retries"] < 1:
                feedback = "Verification failed; fix these and call submit_report again:\n- " + "\n- ".join(
                    verification.failures[:10]
                )
                skipped = [
                    ToolMessage(content="not run: submit_report ends the turn", tool_call_id=str(c["id"]))
                    for c in last.tool_calls
                    if c is not tc
                ]
                update["messages"] = [*skipped, ToolMessage(content=feedback, tool_call_id=str(tc["id"]))]
                update["retries"] = state["retries"] + 1
            return update

        def after_check(state: State) -> Literal["agent", "respond"]:
            return "agent" if _last_is_feedback(state) else "respond"

        g = StateGraph(State)
        g.add_node("agent", agent)
        g.add_node("tools", run_tools)
        g.add_node("verify", check)
        g.add_node("respond", lambda state: {})
        g.add_edge(START, "agent")
        g.add_conditional_edges("agent", after_agent)
        g.add_conditional_edges("tools", lambda s: "respond" if s.get("stop") else "agent")
        g.add_conditional_edges("verify", after_check)
        g.add_edge("respond", END)
        return g.compile()

    async def _run(self, question: str, user_id: str, token: str, stats: RunStats) -> State:
        async with (
            stdio_client(server_params(user_id, token)) as (read, write),
            ClientSession(read, write) as session,
        ):
            await session.initialize()
            tools = await load_mcp_tools(session)
            graph = self._graph(tools, stats)
            state: State = {
                "messages": [SystemMessage(SYSTEM_PROMPT), HumanMessage(question)],
                "calls": [],
                "submitted": None,
                "verification": None,
                "retries": 0,
                "stop": None,
            }
            try:
                result: State = await graph.ainvoke(state, {"recursion_limit": self.budgets.recursion_limit})
            except GraphRecursionError:
                return {**state, "stop": "budget: recursion limit"}
            return result

    async def ask(self, question: str, user_id: str, token: str, stats: RunStats | None = None) -> Report:
        stats = stats or RunStats()
        started = time.monotonic()
        try:
            state = await asyncio.wait_for(self._run(question, user_id, token, stats), self.budgets.timeout_s)
        except TimeoutError:
            stats.wall_s = time.monotonic() - started
            stats.stop_reason = "budget: wall clock"
            return _could_not_verify("budget: wall clock", [])
        except Exception as err:  # the provider or a tool failed: never a partial answer, never its message
            stats.wall_s = time.monotonic() - started
            if stats.wall_s >= self.budgets.timeout_s:
                # the deadline's cancellation can surface from the MCP client's task group as another error
                stats.stop_reason = "budget: wall clock"
                return _could_not_verify("budget: wall clock", [])
            stats.stop_reason = f"error: {_leaf_types(err)}"
            log.warning("research request failed: %s", stats.stop_reason)
            return _could_not_verify("the language model or a tool failed", [])
        stats.wall_s = time.monotonic() - started
        calls = state["calls"]
        v, submitted = state["verification"], state["submitted"]
        if state.get("stop"):
            stats.stop_reason = str(state["stop"])
            return _could_not_verify(str(state["stop"]), calls)
        if v is None or submitted is None:
            stats.stop_reason = "no report submitted"
            return _could_not_verify("the model did not submit a report", calls)
        if not v.ok:
            stats.stop_reason = "verification failed"
            return _could_not_verify("verification failed", calls, v)
        stats.stop_reason = "verified"
        return Report(
            type=submitted.type,
            answer=submitted.answer,
            claims=submitted.claims if submitted.type == "answer" else [],
            tool_calls=_log(calls, self.budgets.log_result_chars),
            data_ranges=_ranges(calls),
            disclaimer=DISCLAIMER,
            verification=v,
        )


def _leaf_types(err: BaseException) -> str:
    """The innermost exception types (the MCP client's task group wraps failures in groups); types
    only, never messages, which can carry provider request details."""
    inner = getattr(err, "exceptions", None)
    if inner:
        return ", ".join(_leaf_types(e) for e in inner)
    return type(err).__name__


def _last_is_feedback(state: State) -> bool:
    last = state["messages"][-1]
    return isinstance(last, ToolMessage) and str(last.content).startswith("Verification failed")


def _content_text(raw: Any) -> str:
    """langchain-mcp-adapters returns MCP text content as a string or a list of content blocks."""
    if isinstance(raw, list):
        return "".join(str(b.get("text", "")) if isinstance(b, dict) else str(b) for b in raw)
    return str(raw)


def _log(calls: Sequence[CallResult], limit: int) -> list[ToolCallRecord]:
    return [
        ToolCallRecord(
            id=c.id,
            name=c.name,
            args=c.args,
            ok=c.ok,
            result_truncated=truncate_for_model(json.dumps(c.result, separators=(",", ":")), limit),
        )
        for c in calls
    ]


def _could_not_verify(reason: str, calls: Sequence[CallResult], v: Verification | None = None) -> Report:
    return Report(
        type="could_not_verify",
        answer=f"Could not produce a verified answer ({reason}). No unverified numbers are shown.",
        claims=list[Claim](),
        tool_calls=_log(calls, Budgets().log_result_chars),
        data_ranges=_ranges(calls),
        disclaimer=DISCLAIMER,
        verification=v or Verification(ok=False, failures=[reason], claims_checked=0, numbers_checked=0),
    )
