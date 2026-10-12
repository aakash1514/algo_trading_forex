# Trading terminal fixtures

Real responses, saved byte for byte. Nothing here is written or edited by hand.

| File | What | Recorded | sha256 |
|---|---|---|---|
| feed-status-none.json | `GET /api/market/feed/status` from market-service with the default config (`MARKET_FEED` unset) | 2026-10-12, commit `8799173` (step 6a) | `41ab102a9368d8eb9a1b42e1989f6da2aee06c661035e94c8785f5667686fa53` |
| feed-status-mock.json | The same endpoint with `MARKET_FEED=mock`, after the first published tick | 2026-10-12, commit `8799173` | `360f00d1b1ea87553a40540d2072302f9b9b00a3179e6da87a9593255938f4c6` |
| tick-eurusd-mock.json | A simulated EUR/USD tick as market-service wrote it to Redis (`price:last:EUR_USD`); ws-gateway relays the same object as `tick:EUR_USD` | 2026-10-10 | `1042c4e2df1494d549008a9f2db9528ea3b561df9359b8dc6c41eb5105fb9049` |

No `degraded` or `down` status has been recorded: the only provider that exists (the simulator) never fails.
Tests of those states change only the `state` field of the recorded mock status, and say so.
