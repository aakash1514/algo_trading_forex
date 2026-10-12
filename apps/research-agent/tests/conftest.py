"""Suite-wide guard: no test may build the real chat model (the default suite never calls an LLM;
agent tests replay recorded transcripts)."""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest

from research_agent import agent


@pytest.fixture(autouse=True)
def _no_real_llm(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    def refuse(*_: Any, **__: Any) -> Any:
        raise AssertionError("the test suite must not build the real LLM (replay a recorded transcript instead)")

    monkeypatch.setattr(agent, "llm_from_env", refuse)
    yield
