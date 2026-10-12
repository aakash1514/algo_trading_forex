# Test fixtures

All fixtures are real outputs: real ml-service responses, real tool results from the dev database, and
real LLM replies. Nothing here is generated or edited by hand. The sha256 values are of the files as
committed (LF line endings).

## ml/: ml-service responses

Recorded by `scripts/record_ml_fixtures.py` against a running ml-service (response bodies only, no
headers). `evaluation.json` is `GET /api/ml/evaluation`; each `predictions-*.json` is
`GET /api/ml/predictions/{instrument}` for one test month per pair (ml-service's parity months).

| sha256 | File |
|---|---|
| `2fb43afa22ae666be98d5420c44315e095a6f24cd63ac1901eae30bc1c6547fb` | ml/evaluation.json |
| `71356f99f156ea2f92f5c0f8f69c8f9c4c79fa2b27c9d909c07121512f998115` | ml/predictions-EUR_USD-2022-03.json |
| `43021b5903a81f341d0dfe16546a0e046d3eada3c8837cf5ab54ec9c255eb4ea` | ml/predictions-GBP_USD-2019-06.json |
| `7439fafbae2be694ce85eee5f2b463beacb899b40b6b4d97f81fabffad05bf1d` | ml/predictions-USD_JPY-2020-03.json |
| `11066f8d79c2d33dee520137ea1d217dcdb2d62d358181be986755ad2f7b8e85` | ml/predictions-XAU_USD-2017-10.json |

## tools/: tool results (verifier tests)

Recorded by `scripts/record_tool_fixtures.py`: one tool call each, `{id, name, args, result}`, from
the dev database as the research login (and ml-service for `ml-evaluation-eurusd`). The backtest result
is `research_demo`'s EUR/USD 2022 run. `error-audusd` is the real refusal for a pair outside the data.

| sha256 | File |
|---|---|
| `9a2acc268003d0db33642d4a28811420e2e513c2c13e1e33366835f56fac9a8a` | tools/backtest-demo-eurusd-2022.json |
| `4b3fb2d29e00b12995010a1bc2e1f61945edc6f1e016786a504e1aae9e226acb` | tools/bars-usdjpy-2022-03-1d.json |
| `e293ef56c59b8cdf9ee161cb623c3f2c537354ade378858920f3f9e4ab599d6d` | tools/error-audusd.json |
| `38123405dea89fb504e50474bb1beca6eacc03bc2366863bee649d25266142b2` | tools/ml-evaluation-eurusd.json |
| `0319abafdab83696a38fa904096b10c4a6f5838df2018466ad5eeec2d4765076` | tools/stats-eurusd-2022-1d.json |
| `9a7680c97097b9d201bb41ba24c5f950c758eaad15869d2d5873e417b4659e10` | tools/stats-xauusd-2020-1d.json |

## transcripts/: real LLM transcripts (agent tests)

Recorded by `scripts/record_transcripts.py` from Groq `openai/gpt-oss-120b` running the real agent.
Each keeps only what the model said: reply text, tool calls (provider ids renamed `tc_1`, `tc_2`, ...;
claims cite the agent's own `call_N` ids) and token counts. No keys, auth headers, provider request ids
or response metadata. The final report and run stats are kept for reference.

| sha256 | File | Used for |
|---|---|---|
| `f420b88ab4d7324256a602f971cded88e19c96c2241e339c4bcdf596bbbcc892` | transcripts/backtest.json | research_demo's USD/JPY run, end to end |
| `cea821b6c768998d56c25586ce932f451c04bfa8876a16d828f84c660ca3726e` | transcripts/buy-sell.json | refusal; recursion and wall-clock budgets |
| `8238f2edaa263f3263c5571cc54a9c40fa074ea71d38b9f44a4e7393539508fb` | transcripts/difference.json | arithmetic question answered with source values |
| `d88efb8923ebf1260595512b2aa090bd0469609c63b711571813d34f1ee6a90d` | transcripts/eurusd-2022.json | market stats answer; tool-call and model-call budgets; the retry test (below) |
| `3dbec22d5e3aaec74e2427b1244901751662a5f0569f7ca79cd3953d47cc1ef8` | transcripts/ml-gbpusd.json | ML evaluation answer |
| `e74ef06d13321c2f7b10267f876a9f66867a9bdfe237445fb523736f8a955dce` | transcripts/other-pair.json | not_in_data (pair) |
| `71e3ab5aa8ea336ab77fc247d82344e93712601dadbd4cd527af2aab32c6f8fd` | transcripts/out-of-range.json | not_in_data (year) |

**Retry test** (`test_a_failed_verification_is_retried_once_then_could_not_verify`): real eurusd-2022
submit_report reply with its cited tool call removed; no values changed. The reply is replayed twice
without the `get_market_stats` call it cites, so the verifier rejects it both times. No live run produced
a naturally failing transcript to use instead.
