# Overnight report: step 5b, Research page (2026-10-12)

Branch `step-5b-research-page` from main after the step-5 merge (PR #4). All commits are pushed.
**PR not opened and not merged**, as instructed; `main` is untouched. (The step-4 overnight report this file
held before is in git history.)

**Manual browser check: pending.** The checklist is in `docs/validation/research-page-e2e.md`.

## Summary

| Item | Result |
|---|---|
| research-agent CORS | Only `http://localhost:4200`, with credentials; 3001 and `http://evil.example` denied (no allow-origin, preflight 400); no wildcard |
| Question cap | Already existed (500, 422 before the agent runs); now named `MAX_QUESTION_CHARS`, and tested |
| Prompt rule 6 | Returns and % changes come from `get_market_stats` |
| Eval run 3 | **9/10** (run 2's question 8 fixed; question 3 hit a Groq HTTP 400), run once, not tuned |
| Research page | `/research` + nav link; mutation with 100 s timeout and no retry; one request in flight; text-only rendering; `could_not_verify` shows the warning only |
| Fixtures | Real `/ask` bodies: answer, refusal, not_in_data, 422, a real `could_not_verify` (no LLM key) |
| Automated HTTP e2e | **7/7** |
| Clean matrix (no LLM key) | **18/18 projects pass** (719 s); Jest 590, pytest 151 + 47 |
| Opt-in suites | All pass (229 + 77 + 65 + 195) |
| Open questions | 1 new: OVERNIGHT-QUESTIONS #4 (Groq 400 diagnostics); nothing blocked or skipped |

## Commits

| Commit | Message |
|---|---|
| `3d53333` | feat(research): CORS for the frontend origin only |
| `20d55d0` | test(research): question length cap |
| `27525e9` | fix(research): returns and % changes come from get_market_stats |
| `7b82530` | docs(validation): research agent eval run 3 |
| `ce4219e` | feat(frontend): research API endpoint and helpers |
| `44a1fc7` | test(frontend): recorded research reports |
| `14242c3` | feat(frontend): Research page |
| `432a39e` | docs(validation): research page end to end, automated HTTP check |
| (this commit) | docs: step 5b close-out; phase summary, CLAUDE.md, overnight report |

The commit order differs from the plan in one place: the frontend API layer (`ce4219e`) was committed while
eval run 3 was still running, so it comes before the eval doc. Affected checks ran before every code commit
(`npx nx affected -t lint typecheck test build --parallel=2`). For the docs-only eval commit `7b82530`, no
project is affected.

## Live eval: runs 1, 2 and 3 (`docs/validation/research-agent-eval.md`)

| # | Question | Expected | Run 1 (`eb93fde`) | Run 2 (`ad50574`) | Run 3 (`27525e9`) |
|---|---|---|---|---|---|
| 1 | XAU/USD 2020 return | answer | PASS | PASS | PASS |
| 2 | EUR/USD 2022 return (negative) | answer | PASS | PASS | PASS |
| 3 | EUR/USD 2021 up/down bars | answer | PASS | PASS | **FAIL** (could_not_verify: Groq HTTP 400) |
| 4 | USD/JPY open/close 2022-03-08..10 | answer | PASS | PASS | PASS |
| 5 | my XAU/USD backtest: net USD, win rate | answer | PASS | PASS | PASS |
| 6 | USD/JPY LSTM accuracy vs break-even | answer | **FAIL** (eval check) | PASS | PASS |
| 7 | XAU/USD hit rate, October 2017 | answer | **FAIL** (eval check) | PASS | PASS |
| 8 | GBP/USD return 2022-12-19..30 | answer | PASS | **FAIL** (agent: open/close, no return) | PASS |
| 9 | "Which pair should I buy tomorrow?" | refusal | PASS | PASS | PASS |
| 10 | EUR/USD, first week of Jan 2023 | not_in_data | PASS | PASS | PASS |
| | **Pass** | | **8/10** | **9/10** | **9/10** |
| | Types as expected | | 10/10 | 10/10 | 9/10 |
| | Tokens / model calls / tool calls | | 36,750 / 20 / 9 | 39,781 / 21 / 9 | 35,387 / 20 / 9 |
| | HTTP 429s | | 0 | 0 | 0 |
| | Wall time (sum) | | 76.6 s | 72.8 s | 121.0 s |

- **Run 3, question 8 (prompt rule 6's target):** used `get_market_stats` and answered -0.46291%, verified.
- **Run 3, question 3:** the Groq API returned HTTP 400 on the second model call. The service returned
  `could_not_verify`, with no unverified numbers. Only the exception type is logged, so the exact 400 reason
  is unknown (question #4).
- **Run 3 wall time:** higher because four single questions took 15.9-27.2 s, with the same call counts as
  before; the cause wasn't measured.
- **The eval's `--note`:** Nx turned its commas into spaces; that one label line was corrected by hand.
  No result was edited.

## Automated HTTP end to end (`docs/validation/research-page-e2e.md`)

Real services: auth-service, ml-service, research-agent, and the frontend's production build. Logged in as
research_demo; bodies and CORS response headers only, no request headers and no token.

| Check | Result |
|---|---|
| POST /ask answer, Origin 4200 | PASS: 200, answer (GBP/USD 2021 -0.9625%), allow-origin 4200, credentials true |
| POST /ask refusal, Origin 4200 | PASS: 200, refusal, allow-origin 4200 |
| POST /ask not_in_data, Origin 4200 | PASS: 200, not_in_data, allow-origin 4200 |
| POST /ask refusal, Origin 3001 | PASS: 200, refusal, **no allow-origin** |
| Preflight from 4200 / from 3001 | PASS: 200 allowed / 400 rejected |
| GET http://localhost:4200/research | PASS: 200 |

CORS doesn't stop the 3001 request from reaching the agent; it stops a browser page on 3001 from reading
the response. Starlette still sends `access-control-allow-credentials: true` on that response, but without an
allow-origin header a browser blocks the read.

## Clean matrix and opt-in suites

**Clean matrix**
- The GROQ_API_KEY line in `.env` was commented out, then restored; the `.env` sha256 was checked identical
  afterwards, and the key was never printed.
- Steps: `npx nx reset`, `dist/` deleted, then
  `EXPECT_NO_LLM_KEY=true npx nx run-many -t lint typecheck test build --parallel=2`.
- **All 18 projects pass** (719 s).
- ESLint: 0 errors, 51 warning lines (the same 51 as before), none in a step-5b file.
- Jest: 590 passed (561 before, plus 29 new frontend tests), 23 skipped.
- pytest: research-agent 151 passed, 79 skipped (including the passing no-key check); ml-service 47 passed,
  30 skipped.

**Opt-in suites** (key restored, `--skip-nx-cache`)

| Suite | Result |
|---|---|
| research-agent `RUN_DB_TESTS=true RUN_LIVE_ML=true` (ml-service running) | 229 passed, 1 skipped (the no-key check, which runs only in the clean matrix) |
| ml-service `RUN_DB_TESTS=true` | 77/77 |
| market-data-import `RUN_DB_TESTS=true` | 65/65 |
| order-service `RUN_DB_TESTS=true` | 195/195 |

## Secrets

- **GROQ_API_KEY:** commented out twice, for the `could_not_verify` fixture and for the clean matrix, and
  restored both times. The first time a temporary `.env` copy in the session scratchpad was compared and
  deleted; the second time only a hash was kept. The value was never printed or committed.
- **Demo password:** read from `.env` by the scripts and never printed.
- **Scans:** the fixtures and the e2e doc were checked for tokens (`eyJ`, `Bearer`, `gsk_`): none found.
  Both scripts also refuse to write if the access token appears in a response.
- **Still pending from step 5:** rotate GROQ_API_KEY (part of it was printed to the local terminal then).

## Open questions and items

- **docs/OVERNIGHT-QUESTIONS.md #4:** should the agent log the provider's error code (e.g. `tool_use_failed`)
  so a 400 like run 3's can be diagnosed?
- **The manual browser check is pending:** steps and expected results are in
  `docs/validation/research-page-e2e.md`.
- **No natural verification-failure `could_not_verify` has been recorded.** No live call produced one; the
  real fixture comes from the no-key path and has no tool calls.
- **No per-user server-side rate limit on `/ask`.** A user can spend the shared free quota from several tabs
  (step 7).
- **Other services still allow 3001 with credentials:** narrow them before deployment (CLAUDE.md step 7).

## Pull request

Not opened. Compare: https://github.com/aakash1514/algo_trading_forex/compare/main...step-5b-research-page?expand=1

Title and description: `docs/phase-summaries/step-5-research-agent.md` §13, "Pull request (step 5b)". The
description states "Manual browser check: pending" and has no attribution lines.
