"""An in-memory QuotaStore with Redis's INCR + EXPIRE NX semantics, so the default suite never talks to
Redis (test_quota.py checks the real commands against the dev Redis when RUN_DB_TESTS=true)."""

from __future__ import annotations


class MemoryQuotaStore:
    def __init__(self) -> None:
        self.counts: dict[str, int] = {}
        self.ttls: dict[str, int] = {}

    async def incr_with_ttl(self, key: str, ttl_s: int) -> int:
        self.counts[key] = self.counts.get(key, 0) + 1
        self.ttls.setdefault(key, ttl_s)
        return self.counts[key]


class DownQuotaStore:
    """Redis unreachable."""

    async def incr_with_ttl(self, key: str, ttl_s: int) -> int:
        raise ConnectionError("Error 111 connecting to redis.internal:6379. Connection refused.")
