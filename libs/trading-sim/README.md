# trading-sim

`@forexedge/trading-sim`: the trading rules shared by the backtester (ws-gateway) and replay, as pure
functions on integer points. No I/O, no NestJS, no Kafka.

- `fills.ts`: next-open fills (BUY at the ask, SELL at the bid), SL/TP on the exit-side quotes (gap at the
  open, level inside the bar, SL first when both are inside one bar), close quotes, pip points.
- `money.ts`: units, commission (0.7 pip per side), USD cents from points (USD/JPY at the exit fill),
  rounding half away from zero, marking an open position to market.

Run `npx nx test trading-sim`.
