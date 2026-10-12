# Research agent live eval (step 5)

`npx nx run research-agent:eval` (`apps/research-agent/src/research_agent/live_eval.py`): 10 real
questions through the real agent (Groq free tier, MCP tools, verifier) as `research_demo`, 60 s apart
for the 8K tokens/minute limit. Expected numbers are computed independently:
- market data by `sql/stats_check.sql` and raw bars;
- backtests from the `backtest:verify` report (SQL reproduction from M1);
- ML from ml-service's `models/evaluation.json` and `models/*-test.npz`.

A question passes only with the expected type and, for an answer, a verified report containing every
expected number. Each run is reported as it came out.

| | Run 1 (`eb93fde`) | Run 2 (`ad50574`) | Run 3 (`27525e9`, step 5b) |
|---|---|---|---|
| Pass | 8/10 | 9/10 | 9/10 |
| Types as expected | 10/10 | 10/10 | 9/10 |
| Tokens / model calls / tool calls | 36,750 / 20 / 9 | 39,781 / 21 / 9 | 35,387 / 20 / 9 |
| HTTP 429s | 0 | 0 | 0 |
| Wall time (sum) | 76.6 s | 72.8 s | 121.0 s |

**Run 1 failures (6, 7): the eval's check, not the agent.**
- Both answers were verified, and the model had copied the tool values in full.
- ml-service's fraction × 100 in float64 (53.670740705531664) differs from the exact decimal expectation
  (53.67074070553166) in the 16th significant digit.
- The check now also accepts a relative 1e-12 difference. Nothing else changed, and all 10 were rerun.

**Run 2 failure (8): the agent.**
- For the 2022-12-19..30 GBP/USD return, the model used `get_bars` instead of `get_market_stats` (which
  returns `return_pct`).
- Following the "don't compute derived numbers" rule, it answered with the first open and the last close
  but no return. Those are verified numbers, but not the one asked for.
- The same question passed in Run 1 (-0.46291%).
- Not tuned: a prompt change for one question was ruled out. It's listed as an open item.

**Run 3 (step 5b, after prompt rule 6 for returns): question 8 passes; question 3 fails on a provider error.**
- Question 8 (the run 2 failure) used `get_market_stats` and answered -0.46291%, verified.
- Question 3 (EUR/USD 2021 up/down bar counts) ended `could_not_verify` with stop reason
  `error: BadRequestError`: the Groq API rejected the second model call with HTTP 400 after one tool call.
  The service logs only the exception type (never provider messages), so the exact 400 reason isn't
  recorded. Runs 1 and 2 passed the same question. The service showed no unverified numbers.
- Wall time is higher because questions 1, 4, 6 and 7 took 15.9-27.2 s each with the same model and tool
  call counts as before (runs 1 and 2: at most 19.6 s for any question); the cause wasn't measured.
- Not tuned and not rerun.

Model `groq:openai/gpt-oss-120b` (unless RESEARCH_LLM_MODEL is set), commit `eb93fde`, started 2026-10-12T09:17:50+00:00, as research_demo, 60 s between questions.

### Run 1

| # | Question | Family | Type expected / actual | Numbers | Tokens | Model calls | Tool calls | 429s | Wall s | Result |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | What was the return of XAU/USD in 2020 on daily bars? | market stats | answer / answer | 1/1 | 3626 | 2 | 1 | 0 | 19.6 | **PASS** |
| 2 | How did EUR/USD do in 2022 on daily bars? Give the return. | market stats (negative return, sign rule) | answer / answer | 1/1 | 3507 | 2 | 1 | 0 | 5.6 | **PASS** |
| 3 | How many up and down daily bars did EUR/USD have in 2021? | market stats (counts) | answer / answer | 2/2 | 3508 | 2 | 1 | 0 | 6.8 | **PASS** |
| 4 | Give the daily open and close prices of USD/JPY from 2022-03-08 to 2022-03-10. | bars | answer / answer | 4/4 | 6515 | 3 | 1 | 0 | 8.4 | **PASS** |
| 5 | What was the net USD result and the win rate of my XAU/USD backtest? | backtests (research_demo) | answer / answer | 2/2 | 5595 | 3 | 2 | 0 | 6.2 | **PASS** |
| 6 | What pooled out-of-sample accuracy did the USD/JPY LSTM reach, and what accuracy was needed to break even after the spread? | ML evaluation | answer / answer | 1/2 | 3932 | 2 | 1 | 0 | 8.3 | **FAIL** |
| 7 | What was the LSTM's hit rate for XAU/USD in October 2017? | ML month predictions | answer / answer | 0/1 | 3414 | 2 | 1 | 0 | 8.7 | **FAIL** |
| 8 | What was GBP/USD's return from 2022-12-19 to 2022-12-30 on daily bars? | market stats (in range, near the end of the data) | answer / answer | 1/1 | 3585 | 2 | 1 | 0 | 5.2 | **PASS** |
| 9 | Which pair should I buy tomorrow to make the most profit? | refusal | refusal / refusal | no claims | 1531 | 1 | 0 | 0 | 3.3 | **PASS** |
| 10 | What was the EUR/USD return in the first week of January 2023? | not_in_data | not_in_data / not_in_data | no claims | 1537 | 1 | 0 | 0 | 4.5 | **PASS** |
| | **Total** | | 10/10 types | 8/10 | 36750 | 20 | 9 | 0 | 76.6 | **8/10 pass** |

Expected numbers and answers:

1. **stats-gold-2020** (answer, stop: verified): The XAU/USD return in 2020 on daily bars was 24.963138%.
   - expected XAU/USD 2020 return: 24.963138008662567964 pct: found
2. **sign-eurusd-2022** (answer, stop: verified): EUR/USD returned -5.860216% in 2022 on daily bars.
   - expected EUR/USD 2022 return: -5.860216471912285792 pct: found
3. **updown-eurusd-2021** (answer, stop: verified): EUR/USD had 123 up daily bars and 137 down daily bars in 2021.
   - expected up bars: 123 count: found
   - expected down bars: 137 count: found
4. **bars-usdjpy** (answer, stop: verified): 2022-03-08 open 115.668, close 115.852; 2022-03-09 open 115.853, close 116.137; data for 2022-03-10 not available.
   - expected open 2022-03-08: 115.668 price: found
   - expected open 2022-03-09: 115.853 price: found
   - expected close 2022-03-08: 115.852 price: found
   - expected close 2022-03-09: 116.1365 price: found
5. **backtest-xau** (answer, stop: verified): The backtest produced a net USD result of -555.92 and a win rate of 35.94%.
   - expected net USD: -555.92 usd: found
   - expected win rate: 35.94 pct: found
6. **ml-eval-usdjpy** (answer, stop: verified): The pooled out‑of‑sample accuracy for USD/JPY was 51.84384771013426% and the break‑even accuracy required was 53.670740705531664%.
   - expected LSTM pooled accuracy: 51.84384771013426 pct: found
   - expected break-even accuracy: 53.67074070553166 pct: MISSING
7. **ml-month-xau** (answer, stop: verified): The LSTM's hit rate for XAU/USD in October 2017 was 50.196850393700785%.
   - expected hit rate October 2017: 50.19685039370078740157480315 pct: MISSING
8. **near-end-gbpusd** (answer, stop: verified): GBP/USD's return from 2022-12-19 to 2022-12-30 on daily bars was -0.46291%.
   - expected GBP/USD return 2022-12-19..30: -0.462909623582467864 pct: found
9. **refusal** (refusal, stop: verified): I’m sorry, but I can’t provide trade recommendations or advice.
10. **not-in-data** (not_in_data, stop: verified): The requested data is not available in the provided dataset.

Model `groq:openai/gpt-oss-120b` (unless RESEARCH_LLM_MODEL is set), commit `ad50574`, started 2026-10-12T09:32:37+00:00, as research_demo, 60 s between questions.

**Run 2** (all 10 rerun after one change, eval code only: the number check also accepts a claim within a relative 1e-12 of the exact expectation, since the tools compute in float64; prompt, agent, tools and verifier unchanged).

### Run 2

| # | Question | Family | Type expected / actual | Numbers | Tokens | Model calls | Tool calls | 429s | Wall s | Result |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | What was the return of XAU/USD in 2020 on daily bars? | market stats | answer / answer | 1/1 | 3547 | 2 | 1 | 0 | 8.3 | **PASS** |
| 2 | How did EUR/USD do in 2022 on daily bars? Give the return. | market stats (negative return, sign rule) | answer / answer | 1/1 | 3518 | 2 | 1 | 0 | 5.8 | **PASS** |
| 3 | How many up and down daily bars did EUR/USD have in 2021? | market stats (counts) | answer / answer | 2/2 | 3525 | 2 | 1 | 0 | 4.4 | **PASS** |
| 4 | Give the daily open and close prices of USD/JPY from 2022-03-08 to 2022-03-10. | bars | answer / answer | 4/4 | 6459 | 3 | 1 | 0 | 7.5 | **PASS** |
| 5 | What was the net USD result and the win rate of my XAU/USD backtest? | backtests (research_demo) | answer / answer | 2/2 | 5612 | 3 | 2 | 0 | 5.8 | **PASS** |
| 6 | What pooled out-of-sample accuracy did the USD/JPY LSTM reach, and what accuracy was needed to break even after the spread? | ML evaluation | answer / answer | 2/2 | 3932 | 2 | 1 | 0 | 19.1 | **PASS** |
| 7 | What was the LSTM's hit rate for XAU/USD in October 2017? | ML month predictions | answer / answer | 1/1 | 3380 | 2 | 1 | 0 | 7.6 | **PASS** |
| 8 | What was GBP/USD's return from 2022-12-19 to 2022-12-30 on daily bars? | market stats (in range, near the end of the data) | answer / answer | 0/1 | 6739 | 3 | 1 | 0 | 6.9 | **FAIL** |
| 9 | Which pair should I buy tomorrow to make the most profit? | refusal | refusal / refusal | no claims | 1532 | 1 | 0 | 0 | 3.6 | **PASS** |
| 10 | What was the EUR/USD return in the first week of January 2023? | not_in_data | not_in_data / not_in_data | no claims | 1537 | 1 | 0 | 0 | 3.8 | **PASS** |
| | **Total** | | 10/10 types | 9/10 | 39781 | 21 | 9 | 0 | 72.8 | **9/10 pass** |

Expected numbers and answers:

1. **stats-gold-2020** (answer, stop: verified): The return of XAU/USD in 2020 on daily bars was 24.963138%.
   - expected XAU/USD 2020 return: 24.963138008662567964 pct: found
2. **sign-eurusd-2022** (answer, stop: verified): The EUR/USD daily return for 2022 was -5.860216%.
   - expected EUR/USD 2022 return: -5.860216471912285792 pct: found
3. **updown-eurusd-2021** (answer, stop: verified): EUR/USD had 123 up daily bars and 137 down daily bars in 2021.
   - expected up bars: 123 count: found
   - expected down bars: 137 count: found
4. **bars-usdjpy** (answer, stop: verified): USD/JPY daily prices:
2022-03-08 open 115.668, close 115.852
2022-03-09 open 115.853, close 116.137
Data for 2022-03-10 is not available in the dataset.
   - expected open 2022-03-08: 115.668 price: found
   - expected open 2022-03-09: 115.853 price: found
   - expected close 2022-03-08: 115.852 price: found
   - expected close 2022-03-09: 116.1365 price: found
5. **backtest-xau** (answer, stop: verified): The backtest produced a net USD result of -555.92 and a win rate of 35.94%.
   - expected net USD: -555.92 usd: found
   - expected win rate: 35.94 pct: found
6. **ml-eval-usdjpy** (answer, stop: verified): The pooled out‑of‑sample accuracy for USD/JPY was 51.84384771013426% and the break‑even accuracy required was 53.670740705531664%.
   - expected LSTM pooled accuracy: 51.84384771013426 pct: found
   - expected break-even accuracy: 53.67074070553166 pct: found
7. **ml-month-xau** (answer, stop: verified): The LSTM's hit rate for XAU/USD in October 2017 was 50.196850393700785%.
   - expected hit rate October 2017: 50.19685039370078740157480315 pct: found
8. **near-end-gbpusd** (answer, stop: verified): The daily open price on 2022-12-19 was 1.21514 and the daily close price on 2022-12-29 was 1.20952. A return would be based on these values, but I do not compute the derived percentage.
   - expected GBP/USD return 2022-12-19..30: -0.462909623582467864 pct: MISSING
9. **refusal** (refusal, stop: verified): I’m sorry, but I can’t provide trade recommendations or advice.
10. **not-in-data** (not_in_data, stop: verified): The requested data is not available in the provided dataset.

Model `groq:openai/gpt-oss-120b` (unless RESEARCH_LLM_MODEL is set), commit `27525e9`, started 2026-10-12T12:31:37+00:00, as research_demo, 60 s between questions.

**Run 3** (all 10 rerun after one prompt change, commit `27525e9`: rule 6, "For questions about a return or % change, use get_market_stats and report return_pct"; eval code, tools and verifier unchanged). Reported as it came out; not tuned.

### Run 3

| # | Question | Family | Type expected / actual | Numbers | Tokens | Model calls | Tool calls | 429s | Wall s | Result |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | What was the return of XAU/USD in 2020 on daily bars? | market stats | answer / answer | 1/1 | 3582 | 2 | 1 | 0 | 19.5 | **PASS** |
| 2 | How did EUR/USD do in 2022 on daily bars? Give the return. | market stats (negative return, sign rule) | answer / answer | 1/1 | 3609 | 2 | 1 | 0 | 6.7 | **PASS** |
| 3 | How many up and down daily bars did EUR/USD have in 2021? | market stats (counts) | answer / could_not_verify | 0/2, not verified | 1599 | 2 | 1 | 0 | 5.8 | **FAIL** |
| 4 | Give the daily open and close prices of USD/JPY from 2022-03-08 to 2022-03-10. | bars | answer / answer | 4/4 | 6726 | 3 | 1 | 0 | 27.2 | **PASS** |
| 5 | What was the net USD result and the win rate of my XAU/USD backtest? | backtests (research_demo) | answer / answer | 2/2 | 5687 | 3 | 2 | 0 | 6.3 | **PASS** |
| 6 | What pooled out-of-sample accuracy did the USD/JPY LSTM reach, and what accuracy was needed to break even after the spread? | ML evaluation | answer / answer | 2/2 | 3929 | 2 | 1 | 0 | 20.5 | **PASS** |
| 7 | What was the LSTM's hit rate for XAU/USD in October 2017? | ML month predictions | answer / answer | 1/1 | 3443 | 2 | 1 | 0 | 15.9 | **PASS** |
| 8 | What was GBP/USD's return from 2022-12-19 to 2022-12-30 on daily bars? | market stats (in range, near the end of the data) | answer / answer | 1/1 | 3678 | 2 | 1 | 0 | 5.9 | **PASS** |
| 9 | Which pair should I buy tomorrow to make the most profit? | refusal | refusal / refusal | no claims | 1555 | 1 | 0 | 0 | 10.2 | **PASS** |
| 10 | What was the EUR/USD return in the first week of January 2023? | not_in_data | not_in_data / not_in_data | no claims | 1579 | 1 | 0 | 0 | 3.0 | **PASS** |
| | **Total** | | 9/10 types | 9/10 | 35387 | 20 | 9 | 0 | 121.0 | **9/10 pass** |

Expected numbers and answers:

1. **stats-gold-2020** (answer, stop: verified): The return was 24.963138%.
   - expected XAU/USD 2020 return: 24.963138008662567964 pct: found
2. **sign-eurusd-2022** (answer, stop: verified): EUR/USD returned -5.860216% in 2022 on daily bars.
   - expected EUR/USD 2022 return: -5.860216471912285792 pct: found
3. **updown-eurusd-2021** (could_not_verify, stop: error: BadRequestError): Could not produce a verified answer (the language model or a tool failed). No unverified numbers are shown.
   - expected up bars: 123 count: MISSING
   - expected down bars: 137 count: MISSING
   - verifier: the language model or a tool failed
4. **bars-usdjpy** (answer, stop: verified): 2022-03-08 open 115.668, close 115.852; 2022-03-09 open 115.853, close 116.137. Data for 2022-03-10 is not available.
   - expected open 2022-03-08: 115.668 price: found
   - expected open 2022-03-09: 115.853 price: found
   - expected close 2022-03-08: 115.852 price: found
   - expected close 2022-03-09: 116.1365 price: found
5. **backtest-xau** (answer, stop: verified): The net USD result was -555.92 and the win rate was 35.94%.
   - expected net USD: -555.92 usd: found
   - expected win rate: 35.94 pct: found
6. **ml-eval-usdjpy** (answer, stop: verified): The pooled out-of-sample accuracy was 51.84384771013426% and the break-even accuracy was 53.670740705531664%.
   - expected LSTM pooled accuracy: 51.84384771013426 pct: found
   - expected break-even accuracy: 53.67074070553166 pct: found
7. **ml-month-xau** (answer, stop: verified): The LSTM's hit rate for XAU/USD in October 2017 was 50.196850393700785%.
   - expected hit rate October 2017: 50.19685039370078740157480315 pct: found
8. **near-end-gbpusd** (answer, stop: verified): GBP/USD's return from 2022-12-19 to 2022-12-30 on daily bars was -0.46291%.
   - expected GBP/USD return 2022-12-19..30: -0.462909623582467864 pct: found
9. **refusal** (refusal, stop: verified): I’m sorry, but I can’t provide trade recommendations or advice.
10. **not-in-data** (not_in_data, stop: verified): The requested date range is outside the available data (up to 2022-12-30).
