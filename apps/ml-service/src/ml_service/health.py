"""Health endpoints for the host's probes, outside the API prefix (as every ForexEdge service):

  GET /health/live   the process is up and serving HTTP: 200 {"status": "ok"}
  GET /health/ready  every dependency answers within the timeout: 200 {"status": "ok", "checks": {...}},
                     otherwise 503 {"status": "down", "checks": {"db": "down", ...}}

No auth, and nothing else in the body: no versions, hosts or error messages. A check still running
from an earlier probe is awaited again rather than started twice, so a hung dependency can't use up
the worker threads."""

from __future__ import annotations

import threading
import time
from collections.abc import Callable, Mapping
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Any

from fastapi import FastAPI, Response

CHECK_TIMEOUT_S = 2.0

Check = Callable[[], object]


class HealthRunner:
    def __init__(self, checks: Mapping[str, Check], timeout_s: float = CHECK_TIMEOUT_S) -> None:
        if not checks:
            raise ValueError("A readiness probe needs at least one check")
        self._checks = dict(checks)
        self._timeout_s = timeout_s
        self._pool = ThreadPoolExecutor(max_workers=len(self._checks), thread_name_prefix="health")
        self._in_flight: dict[str, Future[object]] = {}
        self._lock = threading.Lock()

    def _start(self, name: str) -> Future[object]:
        with self._lock:
            running = self._in_flight.get(name)
            if running is None or running.done():
                running = self._pool.submit(self._checks[name])
                self._in_flight[name] = running
            return running

    def run(self) -> tuple[bool, dict[str, str]]:
        futures = {name: self._start(name) for name in self._checks}
        deadline = time.monotonic() + self._timeout_s
        statuses: dict[str, str] = {}
        for name, future in futures.items():
            try:
                future.result(timeout=max(0.0, deadline - time.monotonic()))
                statuses[name] = "ok"
            except Exception:  # any failure or the timeout means "down"; the reason is not echoed
                statuses[name] = "down"
        return all(s == "ok" for s in statuses.values()), statuses


def add_health_routes(app: FastAPI, checks: Mapping[str, Check]) -> HealthRunner:
    runner = HealthRunner(checks)

    @app.get("/health/live")
    def live() -> dict[str, Any]:
        return {"status": "ok"}

    @app.get("/health/ready")
    def ready(response: Response) -> dict[str, Any]:
        ok, statuses = runner.run()
        if not ok:
            response.status_code = 503
        return {"status": "ok" if ok else "down", "checks": statuses}

    return runner
