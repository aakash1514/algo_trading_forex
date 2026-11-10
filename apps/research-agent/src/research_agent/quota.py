"""Daily question quota per user (step 7): every answered /ask spends free-tier LLM quota, so each user
gets RESEARCH_DAILY_LIMIT questions per UTC day (default 20).

The count lives in Redis under research:quota:<user id>:<UTC date>, incremented atomically before the
agent runs and expiring two days later. The user id is only ever the verified token's subject
(auth.current_user): nothing in the request body or headers can name another user, so nobody can spend
or read someone else's quota. A request refused before the count (no token, an invalid body) costs
nothing. If Redis can't be reached the question is refused (503): the limit fails closed, it never
lets questions through uncounted.

Redis from the same variables as the Node services: REDIS_HOST, REDIS_PORT, REDIS_PASS, REDIS_USERNAME,
REDIS_TLS=true."""

from __future__ import annotations

import os
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Protocol

from fastapi import HTTPException, status
from redis.asyncio import Redis

from research_agent.config import REPO_ROOT, load_env_file

DEFAULT_DAILY_LIMIT = 20
KEY_TTL_S = 2 * 24 * 3600  # a day's key outlives its day, then disappears by itself
REDIS_TIMEOUT_S = 2.0


class QuotaStore(Protocol):
    async def incr_with_ttl(self, key: str, ttl_s: int) -> int:
        """Adds one to the key and returns the new count; sets the expiry when the key is new."""
        ...


class RedisQuotaStore:
    def __init__(self, client: Redis) -> None:
        self._client = client

    async def incr_with_ttl(self, key: str, ttl_s: int) -> int:
        async with self._client.pipeline(transaction=True) as pipe:
            pipe.incr(key)
            pipe.expire(key, ttl_s, nx=True)
            count, _ = await pipe.execute()
        return int(count)


def parse_daily_limit(raw: str | None) -> int:
    if raw is None or raw.strip() == "":
        return DEFAULT_DAILY_LIMIT
    value = raw.strip()
    if not value.isdigit() or int(value) < 1:
        raise ValueError(f'RESEARCH_DAILY_LIMIT must be a positive whole number, got "{raw}"')
    return int(value)


def redis_from_env() -> Redis:
    load_env_file(REPO_ROOT / ".env")
    port = os.environ.get("REDIS_PORT") or "6379"
    return Redis(
        host=os.environ.get("REDIS_HOST") or "localhost",
        port=int(port),
        username=os.environ.get("REDIS_USERNAME") or "default",
        password=os.environ.get("REDIS_PASS") or None,
        ssl=os.environ.get("REDIS_TLS") == "true",
        socket_timeout=REDIS_TIMEOUT_S,
        socket_connect_timeout=REDIS_TIMEOUT_S,
    )


@dataclass
class DailyQuota:
    store: QuotaStore
    limit: int
    now: Callable[[], datetime] = lambda: datetime.now(UTC)

    @classmethod
    def from_env(cls) -> DailyQuota:
        load_env_file(REPO_ROOT / ".env")
        return cls(RedisQuotaStore(redis_from_env()), parse_daily_limit(os.environ.get("RESEARCH_DAILY_LIMIT")))

    def key(self, user_id: str) -> str:
        return f"research:quota:{user_id}:{self.now().astimezone(UTC):%Y-%m-%d}"

    async def spend(self, user_id: str) -> int:
        """Counts one question for this user today; raises 429 past the limit, 503 without Redis."""
        try:
            count = await self.store.incr_with_ttl(self.key(user_id), KEY_TTL_S)
        except Exception as err:  # Redis down, timeout, auth: refuse rather than not count
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail={
                    "code": "quota_unavailable",
                    "message": "The question limit can't be checked right now. Please try again later.",
                },
            ) from err
        if count > self.limit:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail={
                    "code": "daily_limit",
                    "message": f"Daily limit of {self.limit} questions reached. It resets at 00:00 UTC.",
                    "limit": self.limit,
                },
            )
        return count
