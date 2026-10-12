# Roadmap step 5: research agent (LangGraph + MCP)

**Outcome:** a Python FastAPI service (`apps/research-agent`, port 3007) that answers English questions
about ForexEdge's own data and nothing else: the 2010-2022 Dukascopy history for EUR/USD, GBP/USD,
USD/JPY and XAU/USD, the caller's completed backtest runs, and the step-4 walk-forward ML evaluation.

**How it works**
- A LangGraph agent calls 7 read-only tools served by an MCP server (FastMCP over stdio, one process per
  request).
- It must finish through a structured `submit_report`.
- A deterministic verifier (no LLM) then checks that every number in the answer, and every claim, matches
  a field of a real tool result.
- If verification fails twice, the response is "could not verify", never the unverified text.

**Runtime limits**
- Per-request budgets: tool calls, model calls, recursion limit, output tokens and wall clock.
- The model is a free-tier Groq model (`openai/gpt-oss-120b`), chosen only through the environment.

**Access**
- Database: a new least-privilege login, `forexedge_research`. It has the history through
  `forexedge_readonly`, plus column-level SELECT on `backtest_runs` through `forexedge_research_reader`.
- ml-service is called with the caller's own access token.

**Live eval:** 10 real questions with independently computed expectations:
`docs/validation/research-agent-eval.md`, with Run 1 and Run 2 side by side.

Branch `step-5-research-agent` (2026-10-12).

## 1. What was built

| Part | Files | What it does |
|---|---|---|
| Service scaffold | `apps/research-agent/{project.json,pyproject.toml,requirements*.in,*.lock}` | Python 3.12 FastAPI; Nx targets setup/lint/typecheck/test/serve/eval; exact pins locked with sha256 (no release younger than 14 days) |
| Auth | `research_agent/auth.py` | HS256 JWT from auth-service (shared secret, `exp` + `sub` required); the caller's token is kept (`repr=False`) for forwarding |
| DB login | migration `1792000000000-ResearchReadRole.ts`, `tools/ops/create-research-db-user.ts`, `research_agent/db.py` | role `forexedge_research_reader` (21 `backtest_runs` columns), login `forexedge_research` in it and `forexedge_readonly`, read-only sessions |
| Demo data | `tools/ops/research-demo-data.ts`, `backtest:verify --report` | permanent users `research_demo` / `research_demo_2` with real runs, each matched by the SQL reproduction |
| Tools | `research_agent/{domain,tools/data,tools/backtests,tools/ml}.py`, `sql/stats_check.sql` | whitelists, inclusive windows, unit-suffixed outputs; market data, backtests, ML |
| MCP server | `research_agent/{mcp_server,mcp_client}.py` | FastMCP stdio server with the 7 tools, identity from the child's environment |
| Verifier | `research_agent/{verifier,report}.py` | claims and answer numbers against tool results; report model |
| Agent + API | `research_agent/{agent,main}.py` | LangGraph loop, budgets, truncation markers, `POST /api/research/ask` |
| Recording + eval | `scripts/record_{ml_fixtures,tool_fixtures,transcripts}.py`, `research_agent/live_eval.py` | real fixtures for tests; opt-in live eval |

## 2. Core concepts

- **MCP (Model Context Protocol).** A standard way to expose tools to a model host: a server lists tools
  (name, description, JSON schema) and runs calls. FastMCP builds the schema from Python type hints
  (a `Literal` becomes an enum). Here the transport is stdio: the agent starts the server as a child
  process and speaks JSON-RPC over its stdin/stdout. `langchain-mcp-adapters` turns the listed MCP tools
  into LangChain tools.
- **LangGraph loop.** A state machine over a typed state (messages, tool results, the submitted report).
  The nodes are agent (model call), tools (run the requested tools), verify and respond, with
  conditional edges between them. `tool_choice="required"` means the model must call a tool on every
  turn, so the only way to finish is `submit_report`; a free-text answer can't slip out unchecked.
- **Deterministic verifier.**
  - Each claim is `{value as written, unit, tool_call_id}`. The value must match a numeric field of that
    call's result whose name ends in the same unit (`_pct`, `_price`, ...).
  - Prices are rounded to the pair's decimals; percentages and pips keep at least 3 significant digits;
    counts and USD must match exactly.
  - Values are signed, and there is no unit conversion.
  - Every number in the answer text must be a verified claim, with its sign taken from a written minus or
    a direction word in the same clause ("fell", "rose", ...).
  - Dates must appear in a tool call.
  - It is plain code, so it is testable on recorded real outputs, and it never "agrees" with the model.
- **Least-privilege DB roles.**
  - Group roles hold grants; logins inherit them.
  - The research login reads the history (existing role) and 21 named `backtest_runs` columns (new role,
    column-level `GRANT SELECT (col, ...)`). It can't read `minio_object_key`, `error_message`, users,
    orders or anything else, and every session is read-only.
  - Granting `backtest_runs` to the shared read-only role would have given the ML login users' runs, so
    the new role is separate.
- **Row scoping in the application.** One DB login serves every user, so the backtest tools put
  `user_id = <caller>` in every WHERE clause: another user's run is NOT_FOUND, never visible.
- **Token forwarding.**
  - The agent calls ml-service with the caller's own access token, passed to the MCP child through its
    environment (never a tool argument, so the model can't see or change it).
  - The token expires on its own, and ml-service sees the real user. No service credential or token
    minting was added.
- **Budgets and truncation.**
  - Per request: 6 data-tool calls, 7 model calls, recursion limit 16, 1,200 output tokens per call and
    90 s wall clock.
  - A tool result over 2,500 characters is cut for the model with an explicit marker ("truncated: N of M
    rows omitted — use get_market_stats or narrow the range"). The verifier always checks the full result.

## 3. Architectural decisions

| Decision | Alternative | Why |
|---|---|---|
| One stdio MCP server per request | One long-lived server | The caller's identity lives in the child's environment, so requests can't mix users and nothing is shared between requests; costs about 1 s of startup |
| Forward the caller's token to ml-service | Mint a service token; an ml-service API key | No new secret and no code that can forge a user; ml-service unchanged |
| Verifier in code, one retry with its failures | An LLM judge | Deterministic, testable, can't be talked round; the retry gives the model the exact failures |
| Own call ids (`call_N`) shown in each tool result | Provider tool-call ids | The model can't see provider ids in Groq's chat format (found live) |
| Claims carry the value as written (a string) | A number | The verifier needs the written decimals to apply the rounding rules |
| No LLM fallback (Groq only, model from env via `init_chat_model`) | Gemini or Hugging Face fallback | Gemini's free tier uses prompts for training and adds about 12 packages; `init_chat_model` keeps the provider a config value |
| No backtest date cutoff | A cutoff constant | The worker reads only `historical_*` and the `BacktestRunMoney` guard means no pre-step-3 run can exist (`docs/validation/research-backtest-tools.md`) |
| Column-level grants on `backtest_runs` | Table grant; a view | Least privilege without a schema change; `minio_object_key` and `error_message` stay unreadable |
| mcp 1.30.0 and langsmith 0.11.2 held back | Latest | mcp 2.x and langsmith 0.12+ require httpx2, whose ownership can't be proven (rejected in step 4 too); langchain-mcp-adapters also needs mcp<2 |
| langchain-mcp-adapters accepted by a byte diff | Write an adapter | No PyPI attestation and no source URL, but the wheel is byte-identical to its 0.3.2 tag (README) |
| Timeframes 1h, 4h, 1d only; 50-row cap on bars | All timeframes | Production serves H1+; the free tier's 8K tokens/minute can't carry long bar lists |
| Tests replay recorded real transcripts | Mock the model; call Groq in tests | No synthetic data, no quota or network in the default suite, real model behaviour |

## 4. Database changes

- Migration `ResearchReadRole1792000000000`: `CREATE ROLE forexedge_research_reader NOLOGIN` (only if
  missing), `GRANT USAGE ON SCHEMA public`, and `GRANT SELECT (21 columns) ON backtest_runs`. Its `down()`
  revokes the grants and keeps the cluster-wide role.
- The login `forexedge_research` is created by `tools/ops/create-research-db-user.ts` from `.env`
  (`RESEARCH_DB_USER`, `RESEARCH_DB_PASS`, the password generated into `.env`, never printed). The
  script checks the allowed reads and that `minio_object_key`, `error_message`, `SELECT *`, users,
  orders, positions, account_summary and writes are refused (42501).
- Data: two permanent dev users (`research_demo`, `research_demo_2`, role TRADER) and their 4 runs, made
  through the real API. Nothing else changed.

## 5. Errors hit, root cause, fix

| Error | Root cause | Fix |
|---|---|---|
| mcp 2.x and langsmith 0.12+ pulled in httpx2 | Both now require httpx2 (unprovable ownership) | Pinned mcp 1.30.0 and langsmith 0.11.2; checked the whole resolved tree |
| langchain-groq wouldn't resolve with groq 1.x | It requires groq<1.0.0 | groq 0.37.1 |
| `pip --dry-run --report` crashed (UnicodeEncodeError) | cp1252 console | `PYTHONUTF8=1` |
| The wheel vs tag diff showed every line different | Windows `core.autocrlf` rewrote line endings on clone | Re-cloned with `core.autocrlf=false`: byte-identical |
| mypy couldn't import the tests' token helper | `tests/` wasn't a package | `tests/__init__.py`, `from tests.tokens import ...` |
| `backtest_runs` was empty | The step-3 verified runs belonged to throwaway users deleted at close-out | `chore(dev): research demo backtest data`: two permanent users, every run matched by the SQL reproduction |
| Demo script: "fetch failed" before the second user | A connection error before any request reached auth-service (its log shows none); exact cause not determined | Re-ran (the script skips users that already have runs) |
| A test query lost its parameter in a refactor | `%s` with no argument | Restored the argument |
| Heredoc edits broke escapes (`\x93`, `−`, `\n`) | Shell/Python string escaping | Edit-tool edits for such lines |
| Verifier: "130 down), from 1.13733" made the price negative | The direction-word search crossed clause boundaries | It stops at the previous number and at `, ; : ( ) . !` |
| Verifier: "2016-2022" read as -2022 | The hyphen was taken as a sign | A hyphen after a digit is a range |
| numpy needed only to read `.npz` in tests | Not a dependency | Small stdlib `.npz` reader |
| **Live 1:** claims cited ids that didn't exist ("unknown tool call call_2") | The model can't see provider tool-call ids | The agent's own `call_N`, shown at the top of each result |
| **Live 2:** Groq 400 `tool_use_failed` on refusals | `type "refusal"` in the prompt read like a tool name; the model invented a `refusal` tool | The prompt says every ending is `submit_report` with a type |
| **Live 3:** "Is the model tradable?" refused | Treated as advice | The prompt says reporting the evaluation is data, answered from `get_ml_evaluation` |
| **Live 4:** an arithmetic question ("difference between returns") refused | The model was told never to compute | Answer with the source values and say derived numbers aren't computed |
| **Live 5:** a half-point mid (1.424935) written in full failed twice | The rule needs price_decimals (1.42494) and the prompt didn't say so | Prompt explains the rounding; verifier feedback names the rule and the rounded value |
| **Live 6:** an empty not_in_data answer passed | Refusal checks didn't require text | Empty refusal/not_in_data text fails |
| Year 2023 in a not_in_data answer failed | Only 2010-2022 were bare years | Any 1900-2099 year is bare in refusals/not_in_data, unless a unit follows or precedes it ("2050 pips" fails) |
| The response log said "use get_market_stats" when cut | The log reused the model's hint | Its own wording: the full result was used for verification |
| Provider/tool failures showed only `ExceptionGroup` | The MCP client's task group wraps errors | Log the innermost exception types (never messages) |
| The wall-clock test failed: cancellation came back as `BrokenResourceError` | anyio's task group converts the cancellation | A failure at or after the deadline counts as the wall-clock budget |
| The first no-key check printed part of GROQ_API_KEY to the local terminal | pytest's assertion rewriting shows the asserted value | The check uses `pytest.fail` with a fixed message; the key should be rotated |
| `GROQ_API_KEY=` didn't unset the key for the clean matrix | On Windows an empty variable is unset, so Nx loaded `.env` again | The key line in `.env` was commented out for the matrix and restored after |
| Jest DB suites replayed "skipped" from the matrix cache | Their inferred targets don't hash `RUN_DB_TESTS` | `--skip-nx-cache` for the DB runs |
| Eval Run 1: 2 of 10 failed on the eval's own check | The model copied float values in full (fraction x 100); the exact decimal expectation differed in the 16th significant digit | The check also accepts a relative 1e-12 difference; all 10 rerun (Run 2) |

## 6. Results

- **Tool cross-checks:**
  - Market stats equal an independent numeric SQL reproduction for every pair and timeframe (a DST week,
    a year of 4h bars, the whole history in 1d).
  - Backtest metrics equal direct SQL and the `backtest:verify` reports.
  - ML values equal ml-service's `evaluation.json` and `manifest.json`, and month hit rates equal the
    offline test predictions.
- **Live answers over HTTP** (logged in as research_demo): GBP/USD 2021 return -0.9625%, high 1.42494,
  low 1.31615, equal to the independent SQL. A buy/sell question is refused, and USD/CHF is "not in data".
- **Live eval** (`docs/validation/research-agent-eval.md`; 10 questions, 60 s apart, 0 HTTP 429s):
  - **Run 1, 8/10:** the 2 failures were the eval's own number check (float64 noise in the 16th
    significant digit); the agent's answers were verified.
  - **Run 2, 9/10:** all 10 rerun after fixing only that check. The failure was the agent: asked for
    GBP/USD's 2022-12-19..30 return, it used `get_bars` and gave the open and close without the return,
    where Run 1 had answered -0.46291%. It wasn't tuned.
  - **Both runs:** types as expected 10/10, about 37-40K tokens per run.
- **Free tier:** a model call is about 1.3-1.6K tokens, and a question takes 1-3 calls (about 1.5-6.5K
  tokens). With 60 s spacing, no 429 was hit.

## 7. Commands cheatsheet

```sh
npx nx setup research-agent                                  # venv + hash-checked install
npx nx run-many -t lint typecheck test -p research-agent     # default suite (never calls the LLM)
RUN_DB_TESTS=true RUN_LIVE_ML=true npx nx test research-agent  # + DB tools, ml-service tools (running)
npx nx serve research-agent                                  # :3007
npx nx run research-agent:eval                               # live eval (Groq quota, ml-service up)

npm run migration:run                                         # ResearchReadRole
npx ts-node --transpile-only tools/ops/create-research-db-user.ts
npx ts-node --transpile-only tools/ops/research-demo-data.ts  # auth-service + ws-gateway running

# Re-record fixtures (real outputs)
.venv/Scripts/python.exe scripts/record_ml_fixtures.py      # ml-service up
.venv/Scripts/python.exe scripts/record_tool_fixtures.py    # DB + ml-service
.venv/Scripts/python.exe scripts/record_transcripts.py [scenario]   # Groq quota

curl -X POST localhost:3007/api/research/ask -H "Authorization: Bearer <access token>" \
  -H "Content-Type: application/json" -d '{"question": "How did EUR/USD do in 2022 on daily bars?"}'
```

## 8. Interview Q&A

**How do you stop an LLM from inventing numbers?**
The model can't answer in free text. It has to call `submit_report` with claims citing tool calls, and
a deterministic verifier checks each claim against the full tool result and each number in the text
against the claims. On failure it gets one retry with the exact failures, then the user gets "could not
verify". The verifier is ordinary code with tests on recorded real outputs.

**Why not use an LLM to check the answer?**
It can be wrong in the same way as the generator, it's nondeterministic, and it can be argued with. A
rule like "the claimed value, rounded as written, equals a `_pct` field of call_2" can't.

**What does MCP give you over plain function calling?**
A standard tool server: schemas, listing and calls over a transport, usable from any MCP host. The
tools here are a separate process with their own DB login, so the agent process never holds a DB
connection, and the same server could be used by another client.

**Why one MCP server per request?**
The caller's identity is fixed in the child's environment, so a request can't act as another user and
nothing leaks between requests. The cost is about a second of startup, which is small next to the model
calls.

**How is user data isolated if one DB login serves everyone?**
The login can only read 21 columns of `backtest_runs`, and every query filters by the caller's id in
SQL, like the Node services' `assertUserId` pattern. Another user's run is NOT_FOUND (tested both ways
between two demo users). A missing user id raises instead of widening the query.

**Why forward the user's token instead of a service credential?**
With HS256, anything that can mint tokens can impersonate anyone. Forwarding adds no new secret,
keeps the expiry, and ml-service sees the real user.

**How do you test an LLM agent without calling the LLM?**
Record real transcripts once, keeping only the reply text, tool calls and token counts. Then replay
them as the chat model through the real graph, MCP server and verifier. Budgets, refusals, truncation
and auth run in the default suite. A separate opt-in eval asks real questions and compares them with
independent SQL.

**What went wrong when it met the real model?**
Six things:
- It couldn't see provider tool-call ids.
- It invented a `refusal` tool.
- It refused "is the model tradable?".
- It refused a question that needed arithmetic.
- It wrote unrounded half-point prices.
- It returned an empty not_in_data answer.

All were found by running it, fixed at the root (ids, prompt wording, verifier rules), and covered by
tests.

**Why are some packages held back?**
mcp 2.x and langsmith 0.12+ depend on httpx2, whose PyPI files have no provenance, so its ownership
can't be proven. The policy is no unprovable dependency, so mcp stays on 1.30 (which
langchain-mcp-adapters needs anyway) and langsmith on 0.11.2. Tracing is off.

**How does the free tier shape the design?**
Groq's free plan allows 8K tokens per minute. Tool outputs are compact JSON with long bar lists
capped at 50 rows (stats instead), results are truncated with markers, and budgets bound the calls.
One question costs about 1.5-6.5K tokens, so the free tier serves roughly one question a minute.

## 9. Resume keywords

LangGraph, LangChain, Model Context Protocol (MCP), FastMCP, langchain-mcp-adapters, tool calling,
structured output, deterministic answer verification, LLM evaluation, Groq, gpt-oss, FastAPI, Pydantic,
psycopg, PostgreSQL column-level privileges and least privilege, JWT token forwarding, row scoping,
supply-chain security (hash-locked pins, provenance, wheel-to-source diff), recorded-transcript
testing, Nx monorepo with Python, TimescaleDB.

## 10. Open items

- Step 7: a Linux image and lock for research-agent (`pywin32` comes with mcp on Windows), the role
  `forexedge_research_reader` in the provider console if `CREATE ROLE` isn't allowed, and a paid LLM tier
  or rate limiting for real traffic.
- Answers copy tool values at full float precision (e.g. 51.67279411764706%); allowed and verified, but
  tools could round percent outputs for readability later.
- The retry path is tested with a real reply replayed without the call it cites; no live run produced a
  naturally failing transcript.
- Eval Run 2, question 8: the model can pick `get_bars` and decline to compute a return that
  `get_market_stats` provides. A general prompt or tool-description change would need a new eval run.
- GROQ_API_KEY: rotate it (part of it was printed to the local terminal by a failing test; never written
  to a file or commit).

## 11. Close-out

**Clean matrix, run without GROQ_API_KEY**
- The key line in `.env` was commented out (an empty variable doesn't unset it on Windows), then restored.
- Steps: `npx nx reset`, `dist/` deleted, then
  `EXPECT_NO_LLM_KEY=true npx nx run-many -t lint typecheck test build --parallel=2`.
- **All 18 projects pass** (605 s).
- ESLint: 0 errors, 51 warning lines in 36 files, none in a file changed by step 5 (the same 51 as in step 4).
- Jest: 561 passed (23 DB tests skipped without `RUN_DB_TESTS`).
- pytest:
  - research-agent: 146 passed, 79 skipped. This includes `test_no_llm_key_is_visible_to_the_suite`,
    which passed: the key was absent.
  - ml-service: 47 passed, 30 skipped.
- An autouse guard also makes any attempt to build the real chat model fail the suite.

**Opt-in suites (key still disabled)**

| Suite | Result |
|---|---|
| market-data-import, `RUN_DB_TESTS=true` (`--skip-nx-cache`) | 65/65 |
| order-service, `RUN_DB_TESTS=true` (`--skip-nx-cache`) | 195/195 |
| ml-service, `RUN_DB_TESTS=true` | 77/77 |
| research-agent, `RUN_DB_TESTS=true RUN_LIVE_ML=true` (ml-service running) | 225/225 |
| Live LLM eval (`npx nx run research-agent:eval`, key restored) | Run 1 8/10, Run 2 9/10 (see §6) |

**Housekeeping:** services were stopped. The demo users and their runs are kept. The research login
password and demo passwords are in `.env` only.

## 12. Pull request

Open: https://github.com/aakash1514/algo_trading_forex/compare/main...step-5-research-agent?expand=1

**Title:** `Roadmap step 5: research agent (LangGraph + MCP) with a deterministic verifier`

**Description:**

````markdown
## Summary
A Python FastAPI service (`apps/research-agent`, port 3007) that answers questions about ForexEdge's own data, and nothing else:
- the 2010–2022 history for EUR/USD, GBP/USD, USD/JPY and XAU/USD;
- the caller's completed backtest runs;
- the step-4 walk-forward ML evaluation.

Every number in an answer is checked against a real tool result before it is returned.

- **Tools (MCP).** A FastMCP server over stdio, one process per request, with 7 read-only tools: available data, bars (capped at 50), market stats, the caller's backtest runs, and ML evaluation/predictions. Every numeric field carries its unit as a suffix (`_pct`, `_price`, `_usd`, …).
- **Agent (LangGraph).** An agent ↔ tools loop that must end with a structured `submit_report` (`tool_choice="required"`).
- **Budgets per request:** 6 tool calls, 7 model calls, recursion limit 16, 1,200 output tokens and 90 s. Tool results over 2,500 characters are cut with an explicit marker.
- **Verifier (no LLM).**
  - Each claim must match a unit-suffixed field of its own tool call: prices at the pair's decimals, percent and pips with ≥ 3 significant digits, counts and USD exact, signed, no unit conversion.
  - Every number in the answer text must be a verified claim, with direction words agreeing with the sign.
  - On failure the model gets one retry with the failures; after that the response is "could not verify", never the unverified text.
- **Behaviour.** Buy/sell/signal questions are refused. Anything outside the data is "not in ForexEdge data".
- **API.** `POST /api/research/ask {question}` (JWT) returns a structured report: answer, claims, tool-call log, data ranges, disclaimer and verification.
- **LLM.** Free-tier Groq `openai/gpt-oss-120b`, chosen only by env via `init_chat_model`. There is no fallback.

## Security and data access
- **Migration `ResearchReadRole`.** A role `forexedge_research_reader` with column-level SELECT on 21 `backtest_runs` columns, not `minio_object_key` or `error_message`.
- **The login** `forexedge_research` (`tools/ops/create-research-db-user.ts`) is in that role and `forexedge_readonly`, and every session is read-only. Nothing new was granted to `forexedge_readonly`, so the ML login still can't read runs.
- **User scoping.** The backtest tools filter by the caller's user id in every query; another user's run is NOT_FOUND.
- **ml-service** is called with the caller's own token, passed through the MCP child's environment, never through tool arguments. No new credential was added.
- **Dependencies.** Hash-locked pins, no release younger than 14 days. mcp is held back at 1.30.0 and langsmith at 0.11.2, because their newer versions need httpx2, whose ownership can't be proven. langchain-mcp-adapters 0.3.2 was accepted after a byte-for-byte diff of its wheel against the 0.3.2 tag.

## Verification
- **Market stats:** equal an independent numeric SQL reproduction for every pair and timeframe.
- **Backtests:** equal SQL and the `backtest:verify` reports, on two permanent demo users whose runs all match the SQL reproduction (`tools/ops/research-demo-data.ts`). There's no date cutoff: the worker reads only `historical_*` and no pre-step-3 run can exist (`docs/validation/research-backtest-tools.md`).
- **ML tools:** equal ml-service's `evaluation.json` and `manifest.json`, and month hit rates equal the offline test predictions.
- **Agent tests** replay recorded real Groq transcripts (no keys or provider ids). They cover refusal, not-in-data, every budget, the retry path, truncation markers, auth and request validation.
- **Live eval** (`docs/validation/research-agent-eval.md`, 10 questions with independent expectations): Run 1 8/10 (both failures in the eval's own number check), Run 2 9/10 after fixing only that check (one agent miss: it gave the open and close instead of the return). 0 rate-limit errors.

## Testing
- Full clean run with `GROQ_API_KEY` removed (`nx reset`, empty `dist/`): lint, typecheck, test and build pass for all 18 projects. Jest 561, pytest 146 + 47. The default suite can't build the real LLM (guard) and asserts no key was visible.
- Opt-in suites: market-data-import DB 65/65, order-service DB 195/195, ml-service DB 77/77, research-agent DB + live ml-service 225/225.

## Not in scope / known limits
- News, web search, sentiment, economic calendar, RAG, multi-turn, streaming and frontend.
- Windows-only lock and Nx targets for now (Linux image in step 7).
- The free tier handles roughly one question a minute.

Write-up: `docs/phase-summaries/step-5-research-agent.md`.
````
