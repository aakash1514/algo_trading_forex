"""The daily question quota (research_agent.quota) through the real app: counted per verified user,
refused past the limit before the model runs, closed when Redis is down, and keyed only on the
token's subject. The agent is a stand-in that counts calls; the real agent's path is test_api.py."""

from __future__ import annotations

import asyncio
import os
import time
import uuid
from datetime import UTC, datetime

import jwt
import pytest
from fastapi.testclient import TestClient

from research_agent.auth import ACCESS_TOKEN_CLAIMS
from research_agent.main import create_app
from research_agent.quota import KEY_TTL_S, DailyQuota, RedisQuotaStore, parse_daily_limit, redis_from_env
from research_agent.report import Report, Verification
from tests.memory_quota import DownQuotaStore, MemoryQuotaStore
from tests.tokens import TEST_USER_ID, WRONG_KEY, auth, token

ASK = "/api/research/ask"
QUESTION = {"question": "What was the EUR/USD return in 2022?"}
OTHER_USER = "bbbbbbbb-0000-4000-8000-000000000006"
NOV_10 = datetime(2026, 11, 10, 23, 59, 59, tzinfo=UTC)


class CountingAgent:
    """Answers with a fixed refusal and counts the questions that reached it."""

    def __init__(self) -> None:
        self.asked: list[str] = []

    async def ask(self, question: str, user_id: str, token: str) -> Report:
        self.asked.append(user_id)
        return Report(
            type="refusal",
            answer="stand-in",
            claims=[],
            tool_calls=[],
            data_ranges=[],
            disclaimer="test",
            verification=Verification(ok=True, failures=[], claims_checked=0, numbers_checked=0),
        )


def app(
    limit: int = 2, store: object | None = None, now: datetime = NOV_10
) -> tuple[TestClient, CountingAgent, DailyQuota]:
    agent = CountingAgent()
    quota = DailyQuota(store or MemoryQuotaStore(), limit, now=lambda: now)  # type: ignore[arg-type]
    return TestClient(create_app(agent, quota)), agent, quota  # type: ignore[arg-type]


def test_the_question_past_the_limit_is_429_with_a_clear_message_and_never_reaches_the_model() -> None:
    client, agent, _ = app(limit=2)
    assert [client.post(ASK, json=QUESTION, headers=auth()).status_code for _ in range(3)] == [200, 200, 429]
    r = client.post(ASK, json=QUESTION, headers=auth())
    assert r.status_code == 429
    assert r.json()["detail"] == {
        "code": "daily_limit",
        "message": "Daily limit of 2 questions reached. It resets at 00:00 UTC.",
        "limit": 2,
    }
    assert agent.asked == [TEST_USER_ID, TEST_USER_ID]


def test_each_user_has_their_own_quota() -> None:
    client, agent, _ = app(limit=1)
    assert client.post(ASK, json=QUESTION, headers=auth()).status_code == 200
    assert client.post(ASK, json=QUESTION, headers=auth()).status_code == 429
    assert client.post(ASK, json=QUESTION, headers=auth(token(sub=OTHER_USER))).status_code == 200
    assert agent.asked == [TEST_USER_ID, OTHER_USER]


def test_a_forged_user_id_cannot_spend_or_use_another_users_quota() -> None:
    store = MemoryQuotaStore()
    client, agent, quota = app(limit=1, store=store)
    now = int(time.time())
    forged = jwt.encode({**ACCESS_TOKEN_CLAIMS, "sub": OTHER_USER, "exp": now + 60}, WRONG_KEY)
    attempts = [
        client.post(ASK, json=QUESTION, headers=auth(forged)),  # another user's id, not signed by auth-service
        client.post(ASK, json={**QUESTION, "user_id": OTHER_USER}, headers=auth()),  # a user id in the body
    ]
    assert [r.status_code for r in attempts] == [401, 422]
    # a user id in a header is ignored: the question counts against the token's own user
    assert client.post(ASK, json=QUESTION, headers={**auth(), "X-User-Id": OTHER_USER}).status_code == 200
    assert store.counts == {quota.key(TEST_USER_ID): 1}
    # the other user's quota is untouched
    assert client.post(ASK, json=QUESTION, headers=auth(token(sub=OTHER_USER))).status_code == 200
    assert agent.asked == [TEST_USER_ID, OTHER_USER]


def test_a_refused_request_costs_nothing() -> None:
    store = MemoryQuotaStore()
    client, _, _ = app(limit=1, store=store)
    assert client.post(ASK, json={"question": ""}, headers=auth()).status_code == 422
    assert client.post(ASK, json=QUESTION).status_code == 401
    assert store.counts == {}


def test_the_count_is_per_utc_day_and_expires() -> None:
    store = MemoryQuotaStore()
    client, _, quota = app(limit=1, store=store, now=NOV_10)
    assert client.post(ASK, json=QUESTION, headers=auth()).status_code == 200
    next_day = DailyQuota(store, 1, now=lambda: datetime(2026, 11, 11, 0, 0, 1, tzinfo=UTC))
    later = TestClient(create_app(CountingAgent(), next_day))  # type: ignore[arg-type]
    assert later.post(ASK, json=QUESTION, headers=auth()).status_code == 200
    assert sorted(store.counts) == [
        f"research:quota:{TEST_USER_ID}:2026-11-10",
        f"research:quota:{TEST_USER_ID}:2026-11-11",
    ]
    assert set(store.ttls.values()) == {KEY_TTL_S}
    assert quota.key(TEST_USER_ID).endswith(":2026-11-10")


def test_redis_down_refuses_the_question_without_reaching_the_model() -> None:
    client, agent, _ = app(store=DownQuotaStore())
    r = client.post(ASK, json=QUESTION, headers=auth())
    assert r.status_code == 503
    assert r.json()["detail"]["code"] == "quota_unavailable"
    assert "redis.internal" not in r.text and "6379" not in r.text
    assert agent.asked == []


@pytest.mark.parametrize(("raw", "limit"), [(None, 20), ("", 20), ("5", 5)])
def test_research_daily_limit(raw: str | None, limit: int) -> None:
    assert parse_daily_limit(raw) == limit


@pytest.mark.parametrize("raw", ["0", "-1", "2.5", "twenty"])
def test_a_bad_research_daily_limit_fails(raw: str) -> None:
    with pytest.raises(ValueError, match="RESEARCH_DAILY_LIMIT"):
        parse_daily_limit(raw)


@pytest.mark.skipif(os.environ.get("RUN_DB_TESTS") != "true", reason="needs RUN_DB_TESTS=true and the dev Redis")
def test_the_redis_store_counts_atomically_and_sets_the_expiry_once() -> None:
    asyncio.run(_redis_store_round_trip())


async def _redis_store_round_trip() -> None:
    client = redis_from_env()
    store = RedisQuotaStore(client)
    key = f"research:quota:test-{uuid.uuid4()}:2026-11-10"
    try:
        assert [await store.incr_with_ttl(key, 600) for _ in range(3)] == [1, 2, 3]
        ttl = await client.ttl(key)
        assert 590 <= ttl <= 600
        await store.incr_with_ttl(key, 5)  # NX: an existing expiry is never shortened or extended
        assert await client.ttl(key) >= 590
    finally:
        await client.delete(key)
        await client.aclose()
