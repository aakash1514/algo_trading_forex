"""Suite-wide guards: no test may build the real chat model (the default suite never calls an LLM;
agent tests replay recorded transcripts), and an app built without an explicit quota counts questions
in memory, never in the dev Redis."""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest

from research_agent import agent, quota
from tests.memory_quota import MemoryQuotaStore


@pytest.fixture(autouse=True)
def _no_real_llm(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    def refuse(*_: Any, **__: Any) -> Any:
        raise AssertionError("the test suite must not build the real LLM (replay a recorded transcript instead)")

    monkeypatch.setattr(agent, "llm_from_env", refuse)
    yield


@pytest.fixture(autouse=True)
def _no_real_redis(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    def in_memory(cls: type[quota.DailyQuota]) -> quota.DailyQuota:
        return cls(MemoryQuotaStore(), quota.DEFAULT_DAILY_LIMIT)

    monkeypatch.setattr(quota.DailyQuota, "from_env", classmethod(in_memory))
    yield
