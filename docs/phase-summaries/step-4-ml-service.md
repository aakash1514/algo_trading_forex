# Roadmap step 4: Python ML service (LSTM)

**Outcome:** a Python FastAPI service (`apps/ml-service`, port 3006) in the Nx repo that serves
LSTM next-hour direction predictions trained walk-forward on the Dukascopy history, read through
a read-only database login. 28 models (4 pairs x test years 2016-2022) were trained offline in
1 h 13 min on the CPU-only laptop and are committed with a manifest. Under the rule fixed before
training (pooled McNemar with a Holm correction over 16 tests), the LSTM **beats 9 of 16**
pair-baseline comparisons, **never beats anti-persistence**, and its pooled accuracy
(51.6-51.8%) is **below the accuracy needed to cover the spread** for every pair (53.2-60.2%).
An independent SQL recount matches the samples and baselines in 28/28 pair-years, a retrained
fold is identical tensor for tensor, and the API's probabilities equal the offline run
(max |dp| 6e-8). The fixed shuffled-label control **fails for GBP/USD**; the diagnosis (a
below-chance majority baseline, not a leak) is reported and the criterion is an open question.
A read-only "Model evaluation" page shows the results, labelled as a historical test, not live
signals. FinBERT and news sentiment were taken out of this step. Branch `step-4-ml-service`
(2026-10-11 to 2026-10-12).

## 1. What was built

| Part | Files | What it does |
|---|---|---|
| Service scaffold | `apps/ml-service/{project.json,pyproject.toml,requirements*.in,*.lock}` | Python 3.12 FastAPI; Nx targets setup/lint/typecheck/test/train/serve via run-commands; exact pins locked with sha256 |
| Lock hashing | `scripts/add_hashes.py` | sha256 of every file of every pin from PyPI's JSON API; refuses releases younger than 14 days |
| Read-only DB access | migration `1791900000000-ReadOnlyRole.ts`, `tools/ops/create-ml-db-user.ts`, `ml_service/db.py` | group role `forexedge_readonly` (SELECT on the history only), login `forexedge_ml`, sessions read-only |
| Data and features | `ml_service/{data,features}.py` | H1 bars as integer points; 10 features from bars <= t; next-bar target |
| Walk-forward | `ml_service/{splits,baselines,metrics}.py` | 7 expanding folds per pair, train-only scaling, baselines, Wilson, McNemar, Holm |
| Training (offline) | `ml_service/{model,training,walk_forward}.py` | LSTM and logistic models, deterministic training, resumable runner, controls |
| Results | `models/`, `ml_service/report.py`, `sql/baseline_check.sql` | 56 state_dicts, test predictions, manifest, evaluation, generated report, SQL check |
| Inference API | `ml_service/{auth,inference,main,parity}.py` | JWT-protected /models, /evaluation, /predictions; parity check |
| Frontend | `apps/frontend/src/{components/ml,lib/ml.ts,store/api/ml.api.ts}`, `/model-evaluation` | read-only evaluation page with a monthly prediction chart |

## 2. Core concepts

- **Walk-forward evaluation.** Train only on the past, test on the next period, roll forward.
  Here: test year Y, validation year Y-1, training 2010 to Y-2, for Y = 2016..2022. Each test
  year is predicted by a model that never saw it, which is how the model would have been used.
- **Look-ahead (leakage).** Any use of information that wouldn't exist at decision time. It
  creeps in through features (using bar t+1), through scaling (statistics from the whole
  series), and through splits (a sample whose target is in the test year used for training).
  Each has a test here: windows and targets are unchanged when later bars are removed; the
  scaler is unchanged when validation/test bars are removed; a sample belongs to the period of
  its target bar.
- **The target.** The direction of the next H1 bar from its open to its close (mid, compared
  exactly in integer points). Open-to-close is the move a trade gets when it fills at the next
  open, as the backtester does, and it ignores weekend gaps. Flat bars and bars under 30 minutes
  have no target.
- **LSTM.** A recurrent network that reads the last 32 hourly bars' features in order and keeps
  a hidden state; the last state feeds one linear unit giving P(up). 5.6k parameters at hidden
  32 (25.8 KB), about 19k at hidden 64.
- **Baselines.** The bar a model has to clear: always the training years' majority direction;
  persistence (the next bar moves like this one); anti-persistence (the opposite: mean
  reversion); and logistic regression on the same inputs (is the LSTM better than a linear
  model?).
- **Paired testing (McNemar).** Two models scored on the same samples differ only where one is
  right and the other wrong; McNemar tests whether those discordant counts are balanced (exact
  binomial). More powerful than comparing two accuracies as if independent.
- **Multiple comparisons (Holm).** 16 tests at 0.05 would give false positives by chance. Holm
  multiplies the smallest p by 16, the next by 15, and so on (keeping the order), controlling
  the chance of any false "beats".
- **Wilson interval.** A 95% interval for a proportion that behaves well near 0/1 and with
  small n; with ~6,200 test samples per year it is about +-1.2 points of accuracy.
- **Break-even accuracy.** Trading every predicted direction from the bar's open to its close
  pays about one spread; with equal average win and loss sizes m and cost c, the edge is zero at
  p = 0.5 + c / (2m). That is 53.2% for EUR/USD and 60.2% for gold: statistically better than a
  coin is not the same as tradable.
- **Label-shuffle control.** Retrain with the training labels shuffled: the inputs keep any
  leak, the labels lose all signal. A control that still predicts well means a leak. Its
  reference must be chance, not a baseline that can be below chance (section 5).
- **Determinism.** Same seed, deterministic algorithms, fixed threads and a seeded batch order
  give the same weights; verified by comparing every state_dict tensor exactly. File hashes of
  `torch.save` output are not byte-stable, so they are only recorded for traceability.

## 3. Architectural decisions

| Decision | Alternatives | Why |
|---|---|---|
| LSTM only; FinBERT out of step 4 | GDELT headlines now | GDELT headlines exist only from 2019-09-22 (~25% of the history) and would be 0.5-0.9 TB to stream; licences unconfirmed; then removed from scope entirely |
| Python FastAPI in the Nx repo via run-commands | A separate repo, an Nx Python plugin | One repo and one task runner; no extra plugin; Windows paths for now, a Linux image in step 7 |
| Read-only group role + login, sessions read-only | The main DB user | Least privilege, two layers; the role creation is idempotent because roles are cluster-wide and test DBs migrate against the same cluster |
| Exact pins + hash-locked from PyPI's JSON | `pip-compile --generate-hashes` | That downloads every platform's torch wheel (several GB); PyPI publishes each file's sha256; plus a 14-day minimum age |
| httpx, not httpx2 | httpx2 (Starlette's suggestion) | httpx2's PyPI files carry no provenance attestation, so pydantic ownership couldn't be proven |
| One model per pair and test year, served by target year | One "latest" model | Every served prediction is out of sample, and the API matches the evaluation exactly |
| Window 32 only | Windows 32 and 96 | Decided on validation only: w96 was 2.7x slower and no better on validation log loss (0.690491 vs 0.690480) |
| Holm over 16 pooled tests, fixed before training | Per-year tests, no correction | One pre-registered decision per pair-baseline with family-wise error control |
| Models committed (4.6 MB) with manifest and sha256 | MinIO | Reproducible deploys; `*.pt`/`*.npz` marked binary so git never alters their bytes |
| Mid OHLC in prediction rows | The page also calls market-service | The page needs only the ML service; prices are display-only |
| Shuffled-label check left failing | Change the criterion after seeing it | Never loosen a check after the fact; diagnose and ask |

## 4. Database changes

- Migration `apps/auth-service/src/migrations/1791900000000-ReadOnlyRole.ts`:
  `CREATE ROLE forexedge_readonly NOLOGIN` only if missing (DO block on `pg_roles`);
  `GRANT USAGE ON SCHEMA public`; `GRANT SELECT` on `historical_candles`, its five aggregates,
  `historical_price_scale`, `historical_coverage` and `instruments`. TimescaleDB propagates the
  grants to the chunk tables. `down()` revokes the grants and keeps the role.
- Login `forexedge_ml` (member of the role) created by `tools/ops/create-ml-db-user.ts` from
  `ML_DB_USER` / `ML_DB_PASS` in `.env` (never in a migration).
- Step 7: on managed Postgres without `CREATE ROLE` in SQL, create the role in the provider's
  console; the migration then only applies the grants.
- No data changes. Throwaway check logins were deleted.

## 5. Errors hit, root cause, fix

| Error | Root cause | Fix |
|---|---|---|
| `pip-compile --generate-hashes` ran > 20 min | It downloads every wheel of every platform to hash it (torch CUDA wheels ~0.9 GB each) | `scripts/add_hashes.py` takes the sha256 from PyPI's JSON API |
| `add_hashes.py` doubled `\` on re-run | The pin line already ended in a continuation | Strip a trailing `\` before appending; idempotency checked by diff |
| Six transitive pins younger than 14 days | pip-compile picks the newest release | Held back explicitly in the `.in` files |
| Nx graph failed: `InvalidEscapeCharacter` in project.json | A shell heredoc collapsed `\\` to `\` | File written with the editor |
| mypy: `config.py` found as `config` and `ml_service.config` | Missing `__init__.py` | Added; `explicit_package_bases` |
| `ModuleNotFoundError: ml_service` for `python -m` | `src/` not on the path | `PYTHONPATH=src`; the Nx `train` target sets it |
| Starlette deprecation of httpx | Starlette 1.7 prefers httpx2 | httpx2 couldn't be proven pydantic's (no provenance); kept httpx with the warning visible |
| Feature test expected NaN in row 0's open-to-close | Only `ret_close` and `gap` need the previous bar | Test corrected |
| Scaler test: mean not 0 | The +-10 clip moved the mean (a 3-year join between two fixtures is an outlier) | Assert standardisation before clipping, then that transform equals the clipped values |
| Shuffled-label control "beats" majority for GBP/USD | The majority baseline is below chance in 2022 (trained "up", the year was 48.84% up); the control is at chance (balanced accuracy 0.509) | Reported as failed; diagnostic added and labelled; criterion question in docs/OVERNIGHT-QUESTIONS.md |
| File sha256 of the retrained model differs | `torch.save`'s zip container isn't byte-deterministic | Compare tensors (identical); hash kept for traceability |
| Headless login didn't leave /login | Filled before React hydrated | Wait for React props on the input |
| `InsecureKeyLengthWarning` in tests | The deliberately wrong test key was 12 bytes | A longer wrong key |

## 6. Results

- **Timing:** timed round (EUR/USD 2022, 4 settings incl. window 96) 24 min 49 s; full run with
  window 32: 28 folds in 1 h 13 min (4,372 s of training), controls 5 min, reproducibility
  1 min. 8 threads (12 was 1.6x slower per batch).
- **Chosen settings:** hidden 64 in 15 folds, hidden 32 in 13.
- **Pooled accuracy 2016-2022 (LSTM):** EUR/USD 51.76%, GBP/USD 51.67%, USD/JPY 51.84%, XAU/USD
  51.63%; anti-persistence 51.66%, 51.76%, 51.87%, 51.94%.
- **Fixed rule (Holm):** LSTM beats logistic, majority and persistence for EUR/USD and GBP/USD;
  persistence for USD/JPY; majority and persistence for XAU/USD (9/16). No difference from
  anti-persistence anywhere.
- **Break-even accuracy:** EUR/USD 53.24%, GBP/USD 56.44%, USD/JPY 53.67%, XAU/USD 60.18%.
- **Checks:** SQL recount 28/28; reproducibility identical; parity max |dp| 5.96e-8 (one month
  per pair, over HTTP); page hit rates equal the offline predictions; GBP/USD control fails its
  fixed check (see above).
- Details: `docs/validation/ml-walk-forward.md`, `docs/validation/ml-inference-parity.md`.

## 7. Commands cheatsheet

```sh
npx nx setup ml-service                       # venv + hash-checked install
npx nx run-many -t lint typecheck test -p ml-service
RUN_DB_TESTS=true npx nx test ml-service      # + read-only DB tests and API parity

npm run migration:run                         # ReadOnlyRole
npx ts-node --transpile-only tools/ops/create-ml-db-user.ts

# Offline training (resumable), controls, reproducibility, report
npx nx train ml-service --args="--out models"
npx nx train ml-service --args="--out models --control-shuffled"
npx nx train ml-service --args="--out models --reproduce EUR/USD:2022"
cd apps/ml-service && PYTHONPATH=src .venv/Scripts/python.exe -m ml_service.report

npx nx serve ml-service                       # :3006
cd apps/ml-service && PYTHONPATH=src .venv/Scripts/python.exe -m ml_service.parity
curl -H "Authorization: Bearer $TOKEN" "localhost:3006/api/ml/predictions/EUR_USD?from=2022-03-01&to=2022-03-31"
```

## 8. Interview Q&A

**Did the LSTM work?**
It is statistically better than three naive baselines for some pairs, but it never beats
anti-persistence, the simple mean-reversion rule, and at about 51.7% it is well below the
53-60% needed to cover the spread. So: it found the same weak mean-reversion a one-line rule
finds, and nothing tradable. The point of the step was to measure that honestly.

**How do you prevent look-ahead in a time-series model?**
Three places. Features use only bars up to t (tested by deleting every later bar and checking
the windows don't change). Scaling uses statistics from the training period only (tested by
deleting validation and test bars and checking the scaler doesn't change). Splits assign each
sample to the period of its target bar, with expanding walk-forward folds. A label-shuffle
control is the end-to-end check.

**Why McNemar and Holm instead of comparing accuracies?**
Both models are scored on the same 43k samples, so their errors are correlated; McNemar uses
only the samples where they disagree, which is the right paired test. With 16 comparisons, some
would pass at 0.05 by chance; Holm keeps the family-wise error at 5%. The rule was written into
the code before training, so the result couldn't shape the test.

**Your leakage control failed for one pair. Is there a leak?**
The evidence says no: the control's balanced accuracy is 0.509 (all four 0.490-0.509) and its
accuracy is indistinguishable from 50%. It "beat" the majority baseline because that baseline
predicts the training years' majority direction, and in 2022 GBP/USD went the other way, so the
baseline was below 50%. The criterion was mis-specified. I left the check failing, reported the
diagnosis separately, and asked whether to change the criterion, rather than redefining a check
after seeing it fail.

**How do you know the served predictions are the evaluated ones?**
The API picks the model whose test year contains the bar and rebuilds the features and scaling
exactly as offline. For one month per pair, the endpoint's probabilities equal the offline
predictions within 6e-8 and the same samples are scored; the page's hit rates equal them too.

**How is training reproducible on a CPU?**
Fixed seeds, `torch.use_deterministic_algorithms(True)`, a fixed thread count and a seeded batch
order. A retrained fold gives an identical state_dict. The file hash differs because
`torch.save`'s container isn't byte-stable, which is why the check compares tensors.

**Why a read-only role with two layers?**
The ML service only needs to read history. The role can only SELECT those tables, and each
session also runs with `default_transaction_read_only`, so a bug or injection can't write; the
tests try both layers.

**What did hardware constrain?**
A 4.6 MB model set trained in 1 h 13 min on an i5 laptop. Dropping window 96 (decided on
validation numbers only) cut the projected 8.3 h to about 2 h; 8 threads beat 12 because of the
efficiency cores.

## 9. Resume keywords

Python, FastAPI, PyTorch, LSTM, time-series forecasting, walk-forward validation, look-ahead
bias, data leakage controls, feature scaling, McNemar test, Holm-Bonferroni, Wilson interval,
statistical significance, baseline comparison, reproducible ML (deterministic training),
model registry and manifest, psycopg, PostgreSQL roles and least privilege, TimescaleDB, JWT
(HS256), supply-chain security (hash-locked dependencies, provenance), Nx monorepo with Python,
Next.js, lightweight-charts, headless Chrome testing.

## 10. Open items

- docs/OVERNIGHT-QUESTIONS.md #3: replace the shuffled-label control's criterion (beat
  majority) with balanced accuracy vs 0.5 and re-run the four controls?
- FinBERT / news sentiment: out of step 4 (no source work done).
- The Nx Python targets use Windows paths; step 7 needs a Linux image.
- Live predictions would need retraining on recent data and live features (step 6).

## 11. Close-out

- Clean matrix: `npx nx reset`, `dist/` deleted, `npx nx run-many -t lint typecheck test build --parallel=2`:
  all 17 projects pass (6 min 31 s); ESLint 0 errors, 51 warning lines in 36 files, none in a file
  changed by step 4 (counted line by line; step 3's "42" came from per-project summaries).
- Tests: Jest 561 passed (23 DB tests skipped without `RUN_DB_TESTS`), pytest 47 passed (30 DB tests
  skipped). With `RUN_DB_TESTS=true`: market-data-import 65/65, order-service 195/195, ml-service 77/77.
- Throwaway logins from the checks deleted; services stopped.
