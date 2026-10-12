"""In the clean matrix (EXPECT_NO_LLM_KEY=true, GROQ_API_KEY empty), proves the suite ran without an
LLM key: with the .env loaded the way the service loads it, the key is still empty. The check never
puts the value in an assertion (pytest would print it)."""

from __future__ import annotations

import os

import pytest

from research_agent.config import REPO_ROOT, load_env_file


@pytest.mark.skipif(os.environ.get("EXPECT_NO_LLM_KEY") != "true", reason="only in the clean matrix")
def test_no_llm_key_is_visible_to_the_suite() -> None:
    load_env_file(REPO_ROOT / ".env")
    visible = bool(os.environ.get("GROQ_API_KEY"))
    if visible:
        pytest.fail("GROQ_API_KEY is visible to the test suite", pytrace=False)
