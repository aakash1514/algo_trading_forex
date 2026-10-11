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
