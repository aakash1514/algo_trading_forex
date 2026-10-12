# ml-service

Python FastAPI service (port 3006, prefix `/api/ml`) for the LSTM next-bar direction
models trained on the imported Dukascopy history (roadmap step 4). The service only
runs inference; training is an offline script.

```sh
npx nx setup ml-service        # venv (Python 3.12) + hash-checked install of both lock files
npx nx lint ml-service         # ruff check + ruff format --check
npx nx typecheck ml-service    # mypy --strict
npx nx test ml-service         # pytest (RUN_DB_TESTS=true adds the dev-DB tests)
npx nx serve ml-service        # uvicorn on :3006

# Offline walk-forward training (reads the history as the read-only login)
npx nx train ml-service --args="--pairs EUR/USD --folds 2022 --out <dir>"
```

Training (offline only): per pair, 7 expanding folds (test 2016..2022, validation the
year before, training everything earlier). Each fold fits the scaler on its training
period, trains the LSTM settings (hidden 32/64 x window 32/96) and the logistic
baseline (window 32/96), picks by validation log loss, and scores once on the test year
together with the majority, persistence and anti-persistence baselines. 8 threads: on
the i5-1240P, 12 threads was 1.6x slower per batch for the largest setting.

Dependencies: exact pins in `requirements.in` / `requirements-dev.in`, locked with hashes.
To change a pin:

```sh
.venv/Scripts/python.exe -m piptools compile --strip-extras --no-emit-index-url -o requirements.lock requirements.in
.venv/Scripts/python.exe scripts/add_hashes.py requirements.lock          # sha256 of every file from PyPI
.venv/Scripts/python.exe -m piptools compile --strip-extras --no-emit-index-url -o requirements-dev.lock requirements-dev.in
.venv/Scripts/python.exe scripts/add_hashes.py requirements-dev.lock
```

`add_hashes.py` reads the hashes from PyPI's JSON API (pip-compile `--generate-hashes`
downloads every platform's torch wheel, several GB) and refuses any pinned release
younger than 14 days. The Nx commands use `.venv\Scripts\python.exe` (Windows); a Linux
image comes with deployment (roadmap step 7).

## API (inference only)

All data endpoints need an auth-service access token (`Authorization: Bearer ...`, HS256 with
the shared `JWT_ACCESS_SECRET`; a token without `sub` or past `exp` is refused).

| Endpoint | |
|---|---|
| `GET /api/ml/health` | public: status and number of models loaded |
| `GET /api/ml/models` | the 28 walk-forward models (pair x test year): periods, samples, chosen setting, sha256, test metrics |
| `GET /api/ml/evaluation` | the 16 pooled LSTM-vs-baseline tests (raw and Holm p), per pair-year metrics, controls, reproducibility, break-even accuracy, SQL check |
| `GET /api/ml/predictions/{instrument}?timeframe=1h&from=YYYY-MM-DD&to=YYYY-MM-DD` | days inclusive, at most 31, within 2016-2022: one prediction per H1 target bar, from the model whose test year contains it (out of sample), with the bar's mid OHLC and actual direction |

These are **historical walk-forward test results, not live signals**. Parity with the offline
run: `python -m ml_service.parity` (writes `docs/validation/ml-inference-parity.md`).
