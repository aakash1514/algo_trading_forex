# Overnight report: roadmap step 4, ML service (2026-10-12)

Branch `step-4-ml-service`, all commits pushed, **not merged**; `main` untouched. (The step-2
overnight report this file held before is in git history.)

## Summary

| Item | Result |
|---|---|
| httpx2 check | **Not provable** (no PyPI provenance attestation for its files); removed, back to httpx |
| Grid | LSTM hidden 32/64 at window 32 (window 96 dropped on validation numbers only); logistic window 32 |
| Training | 28 folds (4 pairs x 2016-2022) in 1 h 13 min, resumable, ETA logged; controls 5 min; rerun 1 min |
| Fixed rule (Holm, 16 pooled tests) | **LSTM beats 9 of 16**; never anti-persistence; below the spread break-even for every pair |
| SQL recount of samples and baselines | 28/28 pair-years match |
| Reproducibility | EUR/USD 2022 retrained: state_dict identical, tensor for tensor |
| Shuffled-label control | **Fixed check fails for GBP/USD**; diagnosed as a below-chance majority baseline, not a leak; question #3 in docs/OVERNIGHT-QUESTIONS.md |
| Inference API | /models, /evaluation, /predictions with JWT; parity with the offline run: max abs. difference 5.96e-08, one month per pair, over HTTP |
| Frontend | /model-evaluation, checked in a production build; month hit rates equal the offline predictions |
| Clean matrix | 17 projects pass (6 min 31 s); Jest 561 + pytest 47; all DB tests pass (65 + 195 + 77) |
| PR | Not opened (no GitHub CLI); compare link, title and description below |

## Results (docs/validation/ml-walk-forward.md)

Pooled 2016-2022, accuracy (95% Wilson interval):

| Pair | LSTM | Logistic | Majority | Persistence | Anti-persistence | Break-even (spread) |
|---|---|---|---|---|---|---|
| EUR/USD | 51.76% [51.29, 52.23] | 50.84% | 50.23% | 48.31% | 51.66% | 53.24% |
| GBP/USD | 51.67% [51.20, 52.14] | 50.51% | 49.86% | 48.24% | 51.76% | 56.44% |
| USD/JPY | 51.84% [51.37, 52.31] | 51.55% | 51.14% | 48.12% | 51.87% | 53.67% |
| XAU/USD | 51.63% [51.15, 52.11] | 51.19% | 50.48% | 48.05% | 51.94% | 60.18% |

Under the fixed rule the LSTM beats: logistic, majority and persistence (EUR/USD, GBP/USD);
persistence (USD/JPY); majority and persistence (XAU/USD). No significant difference from
anti-persistence for any pair, and no pair reaches the accuracy needed to cover the spread.

Shuffled-label control (2022 folds): EUR/USD 48.52% vs majority 48.95%; **GBP/USD 50.29% vs
48.84%, McNemar p 0.017 (fixed check FAILED)**; USD/JPY 52.22% vs 52.44%; XAU/USD 49.16% vs
49.55%. The controls' balanced accuracy is 0.490-0.509 (chance); GBP/USD's majority baseline
predicted up in a year that was 48.84% up. The check was not changed.

## Commits on step-4-ml-service

| Commit | |
|---|---|
| `55d629d` | chore(ml): Python FastAPI service scaffold in Nx |
| `9e3ef60` | feat(db): read-only role for the ML service |
| `e0b06a2` | feat(ml): H1 bar reader, features and next-bar target |
| `daeae7d` | feat(ml): walk-forward splits, train-only scaling and baselines |
| `4eac27a` | feat(ml): LSTM training and evaluation (offline) |
| `b12f556` | chore(ml): back to httpx for the test client (httpx2 unverifiable) |
| `0361864` | feat(ml): resumable walk-forward run, window-32 grid, controls |
| `3385c19` | feat(ml): walk-forward results, controls, reproducibility, report (commit 6) |
| `5a7567b` | feat(ml): inference API (models, evaluation, predictions) with JWT (commit 7) |
| `94e4bb3` | feat(frontend): read-only Model evaluation page (commit 7b) |
| `7d4e606` | docs: complete roadmap step 4; phase summary and CLAUDE.md updates (commit 8) |

(plus this report)

## Left open

1. **docs/OVERNIGHT-QUESTIONS.md #3:** change the shuffled-label control's criterion from
   "must not beat majority" to "balanced accuracy not significantly above 0.5" and re-run
   the four controls? The main conclusion doesn't depend on it.
2. The Nx Python targets use Windows paths; step 7 needs a Linux image.
3. Live predictions would need retraining on recent data (step 6).
4. Outside the repo: your `.env` has `ML_DB_USER`, `ML_DB_PASS` (generated) and
   `ML_SERVICE_PORT`; the dev DB has the role `forexedge_readonly` and the login `forexedge_ml`.

## Pull request

Open: https://github.com/aakash1514/algo_trading_forex/compare/main...step-4-ml-service?expand=1

**Title:** `Roadmap step 4: Python ML service (LSTM), walk-forward evaluation, inference API and evaluation page`

**Description:**

```markdown
## Summary
A Python FastAPI service (`apps/ml-service`, port 3006) that serves next-hour direction predictions from LSTMs trained walk-forward on the Dukascopy history. Training is offline. LSTM only: FinBERT and news sentiment were taken out of this step.

- **Data access:** a read-only login. The migration `ReadOnlyRole` creates the group role `forexedge_readonly` only if it's missing, and grants SELECT on the history only. Every session is also opened read-only.
- **Target:** the direction of the next H1 bar from its open to its close (mid prices, exact in integer points).
- **Features:** 10, computed from bars at or before t only. Scaling uses training-period statistics only.
- **Walk-forward:** 4 pairs × test years 2016–2022. Each test year has a validation year before it and expanding training before that.
- **Grid:** LSTM hidden 32/64 at window 32, chosen on validation log loss; window 96 was dropped on validation numbers only.
- **Baselines:** logistic regression, majority direction, persistence, anti-persistence.
- **Models:** 28 models committed with a manifest and sha256 (4.6 MB). `*.pt` and `*.npz` are marked binary.
- **API:** `/api/ml/models`, `/evaluation` and `/predictions` (JWT; `/health` is public). A prediction always comes from the model whose test year contains the bar, so it is out of sample.
- **Frontend:** a read-only "Model evaluation" page with a monthly chart of predicted vs actual direction, labelled "historical walk-forward test, not live signals".

## Results
The rule was fixed before training: pooled McNemar test, Holm correction across 16 tests.

- The LSTM beats **9 of 16** pair-baseline comparisons.
- It **never beats anti-persistence**.
- Its pooled accuracy (51.6–51.8%) is **below the accuracy needed to cover the spread** for every pair (53.2–60.2%).

Details: `docs/validation/ml-walk-forward.md`.

## Verification
- Independent SQL recount of test samples and baseline hits: 28/28 pair-years match.
- A retrained fold gives an identical state_dict, tensor for tensor. The file hash isn't byte-stable, so it's recorded for traceability only.
- API vs the offline run, one test month per pair, over HTTP: the same samples, max abs. difference 5.96e-08 (`docs/validation/ml-inference-parity.md`).
- Page hit rates equal the offline predictions; the page was checked in a production build.
- **Known failing check:** the shuffled-label control fails its fixed criterion for GBP/USD (50.29% vs a majority baseline of 48.84%, p = 0.017). Diagnosis: the control is at chance (balanced accuracy 0.509), and the majority baseline was below 50% in 2022. The check is reported as failed and was not changed; the criterion is an open question.

## Testing
- Full clean run (`nx reset`, empty `dist/`): lint, typecheck, test and build pass for all 17 projects.
- Jest: 561 tests pass. pytest: 47 pass.
- With `RUN_DB_TESTS=true`: 65 + 195 + 77 DB tests pass.
- Dependencies: exact pins locked with sha256 for every file; no release younger than 14 days. httpx2 was rejected because PyPI has no provenance attestation for it.

## Not in scope / known limits
- FinBERT and news sentiment.
- The Nx Python targets are Windows-only for now (Linux image in step 7).
- No live signals.

Write-up: `docs/phase-summaries/step-4-ml-service.md`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```
