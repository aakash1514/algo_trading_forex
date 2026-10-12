"""Replays a recorded real LLM transcript (tests/fixtures/transcripts, scripts/record_transcripts.py)
as the agent's chat model: each call returns the next recorded reply, unchanged."""

from __future__ import annotations

import json
from collections.abc import Callable, Sequence
from typing import Any

from langchain_core.callbacks import CallbackManagerForLLMRun
from langchain_core.language_models import BaseChatModel, LanguageModelInput
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.runnables import Runnable
from langchain_core.tools import BaseTool
from pydantic import Field

from research_agent.config import SERVICE_ROOT

TRANSCRIPTS = SERVICE_ROOT / "tests" / "fixtures" / "transcripts"


def transcript(name: str) -> dict[str, Any]:
    doc: dict[str, Any] = json.loads((TRANSCRIPTS / f"{name}.json").read_text(encoding="utf-8"))
    return doc


class ReplayChatModel(BaseChatModel):
    replies: list[dict[str, Any]]
    seen: list[list[BaseMessage]] = Field(default_factory=list)
    position: int = 0

    @property
    def _llm_type(self) -> str:
        return "replay"

    def bind_tools(
        self,
        tools: Sequence[dict[str, Any] | type | Callable[..., Any] | BaseTool],
        *,
        tool_choice: str | None = None,
        **kwargs: Any,
    ) -> Runnable[LanguageModelInput, AIMessage]:
        return self

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> ChatResult:
        if self.position >= len(self.replies):
            raise AssertionError("the agent asked for more replies than the transcript has")
        r = self.replies[self.position]
        self.position += 1
        self.seen.append(list(messages))
        msg = AIMessage(
            content=r["content"],
            tool_calls=[
                {"id": t["id"], "name": t["name"], "args": t["args"], "type": "tool_call"} for t in r["tool_calls"]
            ],
            usage_metadata={
                "input_tokens": r["usage"]["input_tokens"],
                "output_tokens": r["usage"]["output_tokens"],
                "total_tokens": r["usage"]["total_tokens"],
            },
        )
        return ChatResult(generations=[ChatGeneration(message=msg)])


def replay(name: str) -> ReplayChatModel:
    return ReplayChatModel(replies=transcript(name)["replies"], seen=[])
