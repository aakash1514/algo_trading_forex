# Overnight questions (2026-10-11)

Decisions held back during the unattended run because they would change money math
beyond the approved scope (hard rule), or are product calls. Nothing here blocked the
rest of step 2; each item says what was done instead.

## 1. Backtest equity, drawdown and Sharpe are in pips, not money (money math)

`MetricsCalculator.buildEquityCurve` starts at 10,000 and adds each trade's net P&L in
**pips**; max drawdown is a percentage of that curve and Sharpe is computed on per-trade
pips. The percentage therefore depends on how many pips a pair moves, not on money:
EUR/USD MA crossover 2022 shows 10.6%, the same strategy on gold 93.3%
(docs/validation/backtest-proof.md). Lots are recorded on every trade but never turn
into money.

Fixing it means valuing each trade in account currency (lots x lot size x price move,
converted quote -> USD as `libs/common/src/lib/money.ts` does for live trading) and a
defined starting balance. That changes money math, so it was **not changed**; the metrics
and trade fields are as before, and step 3 (backtest verification) is the natural place.

**Question:** value backtests in USD (starting balance? lots per trade from the form?),
or keep pips and drop the percentage drawdown?

**Resolved in step 3:** USD, with an initial capital and lots per run; equity marked to
market, drawdown % of peak, daily New York-close Sharpe (see
docs/phase-summaries/step-3-backtest-verification.md).

## 2. Should a backtest's "To" date include that whole day? (product)

`toDate` is an instant; the form sends a date, so "To 2022-12-30" means 2022-12-30 00:00
and that day's bars are excluded (shown by the UI run vs the API run in
docs/validation/backtest-proof.md: only the end-of-data close differs). Left as is.

**Question:** treat the To date as inclusive (send end of day, or compare with < next day)?

**Resolved in step 3:** inclusive. Dates are calendar days (UTC); the window ends at the
next midnight and holds whole bars only.

# Overnight questions (2026-10-12, roadmap step 4)

## 3. The shuffled-label control's fixed criterion fails for GBP/USD; is the criterion right? (check definition)

The plan fixed the leakage control as: the chosen LSTM of each pair's 2022 fold, retrained
on shuffled training labels, **must not beat the majority baseline** (higher accuracy and
McNemar p < 0.05). For GBP/USD it does: 50.29% vs 48.84%, McNemar p = 0.0171. The check
is reported as **failed** in docs/validation/ml-walk-forward.md and was not changed.

Diagnosis (evidence in the report's diagnostic table, added after the run):
- The control is at chance: balanced accuracy 0.5093; its accuracy is not different from
  50% (binomial p = 0.66). All four controls have balanced accuracy 0.490-0.509.
- The majority baseline predicts the training years' more common direction (GBP/USD up,
  50.10%), but 2022 was 48.84% up, so that baseline scores below 50% and any chance-level
  predictor beats it. The criterion confuses "beats a below-chance baseline" with "leaks".
- Accuracy against 50% is confounded the same way (USD/JPY 2022 was 52.44% up, so a
  control predicting mostly "up" is "significantly above 50%" at balanced accuracy 0.4997).

**Question:** replace the control criterion with "balanced accuracy not significantly
above 0.5" (e.g. a permutation or binomial test on balanced accuracy), applied to all
four pairs, and re-run the four controls? Nothing else depends on it; the main
LSTM-vs-baseline conclusion is unaffected.
