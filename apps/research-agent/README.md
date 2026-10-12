# research-agent

Python FastAPI service (port 3007, prefix `/api/research`) that answers English questions
about ForexEdge's own data (roadmap step 5): the 2010-2022 Dukascopy history for EUR/USD,
GBP/USD, USD/JPY and XAU/USD, the caller's completed backtest runs, and the step-4
walk-forward model evaluation. Every number in an answer must come from a read-only tool
result.

```sh
npx nx setup research-agent        # venv (Python 3.12) + hash-checked install of both lock files
npx nx lint research-agent         # ruff check + ruff format --check
npx nx typecheck research-agent    # mypy --strict
npx nx test research-agent         # pytest (RUN_DB_TESTS=true adds the database tests)
npx nx serve research-agent        # uvicorn on :3007
```

## Recreate research demo data

Two permanent dev users (`research_demo`, `research_demo_2`, role TRADER) own real backtest runs made
through the real API, each checked against the SQL reproduction (reports in
`docs/validation/research-demo-backtests.md` and `research-demo-2-backtests.md`). Passwords:
`RESEARCH_DEMO_PASS` and `RESEARCH_DEMO_2_PASS` in `.env`. Re-running skips a user that already has runs.

```sh
npx nx run-many -t build -p auth-service ws-gateway
node dist/apps/auth-service/main.js &       # MinIO, Redis, Kafka and TimescaleDB up (infra/docker-compose.yml)
node dist/apps/ws-gateway/main.js &
npx ts-node --transpile-only tools/ops/research-demo-data.ts
```

## Dependencies

Exact pins in `requirements.in` / `requirements-dev.in`, locked with the sha256 of every file.
The policy is ml-service's: no release younger than 14 days, and every package's ownership
must be provable. To change a pin:

```sh
.venv/Scripts/python.exe -m piptools compile --strip-extras --no-emit-index-url -o requirements.lock requirements.in
.venv/Scripts/python.exe scripts/add_hashes.py requirements.lock          # sha256 of every file from PyPI
.venv/Scripts/python.exe -m piptools compile --strip-extras --no-emit-index-url -o requirements-dev.lock requirements-dev.in
.venv/Scripts/python.exe scripts/add_hashes.py requirements-dev.lock
```

Held back on purpose (see the comments in `requirements.in`):

- **mcp 1.30.0, not 2.x:** mcp 2.x requires httpx2, whose PyPI files carry no provenance, so
  its ownership can't be proven (rejected in step 4 too); langchain-mcp-adapters 0.3.2 also
  requires mcp<2.
- **langsmith 0.11.2:** langchain-core requires langsmith, and langsmith requires httpx2 from
  0.12.0. Tracing is never enabled (no LangSmith in this project).
- **groq 0.37.1:** langchain-groq 1.1.3 requires groq<1.0.0.

Ownership:

| Package(s) | Evidence |
|---|---|
| mcp, langsmith, pydantic, anyio, starlette, uvicorn, ... | PyPI provenance attestation from the project's own GitHub repository |
| langchain, langchain-core, langchain-protocol, langgraph, langgraph-prebuilt, langgraph-checkpoint, langgraph-sdk, langchain-groq | PyPI owner account `langchain`, project URLs pointing at the langchain-ai repositories (no attestations) |
| groq | PyPI owner account `groq`, project URL github.com/groq/groq-python |
| langchain-mcp-adapters 0.3.2 | No attestation and no source URL on PyPI, so the wheel was compared with the source (below) |

**langchain-mcp-adapters 0.3.2, wheel vs source (2026-10-12):** the wheel
`langchain_mcp_adapters-0.3.2-py3-none-any.whl` (sha256 `094e6b3096dbcc408417d5722f6915f164772e50c502ae3d8989405bf12c3c84`,
the hash in `requirements.lock`) was unpacked and compared byte for byte (`diff -r`, checkout with
`core.autocrlf=false`) with tag `langchain-mcp-adapters==0.3.2` of github.com/langchain-ai/langchain-mcp-adapters
(commit `cc0f2843fd5becf2cdb641c910533c3747c3b1ef`): all 10 files of the `langchain_mcp_adapters/` package
are identical, and so is `LICENSE`. The wheel's `RECORD` hashes match its 14 files. The rest is packaging
metadata (`METADATA`, `WHEEL`, `RECORD`, empty `entry_points.txt`; name, version and requirements as in the
tag's `pyproject.toml`).

The lock is Windows-specific for now: mcp pulls in `pywin32` (Windows only), and the Nx targets call
`.venv\Scripts\python.exe`. A Linux image comes with deployment (roadmap step 7).
