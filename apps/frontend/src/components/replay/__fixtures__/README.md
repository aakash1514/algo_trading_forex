# Replay page fixtures

Real replay-service responses and socket events, recorded by
`tools/replay-verify/src/record-frontend-fixtures.ts` against the running auth-service and replay-service and the
imported Dukascopy history, at commit `74fc24e`, as the throwaway user `replayfixture_9ece0d3f@example.com` (deleted
afterwards with `tools/ops/delete-verification-users.ts`). Nothing here is written or edited by hand; this README
is written by the recorder too.

- **REST** (kind rest): the response body byte for byte.
- **Socket** (kind socket): `JSON.stringify` of the payload socket.io-client delivered. Socket.IO sends JSON, so
  this is the received object, re-serialized compactly.

Sessions: EUR/USD from 2022-03-01 09:30 UTC on 1m (a long 0.1 lot with SL/TP 100 points from the bid, closed by
its SL; a short 0.2 closed manually; a cancelled order; ended with a short open), USD/JPY from 2016-06-23 22:00
UTC on 1h (a long and a short open on the Brexit-vote night), EUR/USD from 2022-03-16 17:58 UTC on 1m across
the FOMC decision at 18:00 (calendar; 21 trades closed in one minute for paging, a 22nd later; statistics), and
EUR/USD from 2022-12-30 20:30 UTC stepped to the end of the history.

| File | Kind | What | HTTP | Recorded (UTC) | sha256 |
|---|---|---|---|---|---|
| account-after-order.json | socket | 'account' after the order | — | 2026-11-23T07:49:33Z | `6fd4ef3c758f77a38d6a2384bf43411b2cc6ebde39a9d26ebf665eae373e01df` |
| bar-1m.json | socket | 'bar' after a step on 1m | — | 2026-11-23T07:49:32Z | `138f69611b1ad2b832bd49dddc66d7b7cfe09bf1251a23f1c880b6778d3acb97` |
| calendar-fomc.json | socket | 'calendar' from the step that reached the 18:00 FOMC decision | — | 2026-11-23T07:49:42Z | `d4d07c7c936214b5478751a87c6c085f5ff9e804ac9f303e2b97e4a85c6d0c43` |
| cancel-200.json | rest | POST /orders/:id/cancel of a pending order | 200 | 2026-11-23T07:49:33Z | `86252238fbbd10473c9f4e662348f36151537a2a65d74a2340bfd21a9cc396f6` |
| close-200.json | rest | POST /positions/:id/close (pending until the next minute) | 200 | 2026-11-23T07:49:37Z | `a27690d5a85df87aa1970db7a214e8c9b9372654ea3c567218b03788d6584664` |
| create-201.json | rest | POST /sessions {EUR_USD, 2022-03-01T09:30Z, 1m, 10000} | 201 | 2026-11-23T07:49:26Z | `6da6d9accb676afe5ac228165e6c3e3b38b2ec77ebd013eebd4a654ebea3e897` |
| end-200.json | rest | POST /sessions/:id/end with one position open | 200 | 2026-11-23T07:49:41Z | `b5588425e98abca006ed7bc24839637d9e29743357ae4fbb791ae3f4a755b292` |
| end-of-data.json | socket | 'endOfData' at the pair's last minute | — | 2026-11-23T07:49:53Z | `cbebc4e6c590316edb6ac997e9c1852c2590a02b00a4b0ce81fa5afb4812e656` |
| ended.json | socket | 'ended' after the end | — | 2026-11-23T07:49:41Z | `b5588425e98abca006ed7bc24839637d9e29743357ae4fbb791ae3f4a755b292` |
| order-201-pending.json | rest | POST /orders BUY 0.1 lots, SL bid-100 points, TP bid+100 points | 201 | 2026-11-23T07:49:32Z | `12c2a02c1913b0c29efedaa1c88b1278201e3a9c18f74947272362eb90f27ace` |
| order-400-margin.json | rest | POST /orders BUY 100 lots on 10,000 USD | 400 | 2026-11-23T07:49:33Z | `8802eeb12888fc491b78054b06b0adb6d4b4fe5dfbce168ea273da403457f31f` |
| order-400-sl-side.json | rest | POST /orders BUY with the stop loss above the bid | 400 | 2026-11-23T07:49:33Z | `7ec8bd3e727a30f7394c0670ec643ac27b0257e214000af650cbf7f319c0f273` |
| positions-closed-later.json | socket | 'positions' from the step that closed a 22nd trade, after the pages were loaded | — | 2026-11-23T07:49:51Z | `5674c3dd99bede359743be985c4382c4b708d249e66ed37a9f16bbf1c9745c61` |
| positions-closed-level.json | socket | 'positions' when the long closed at its SL or TP while playing | — | 2026-11-23T07:49:40Z | `d2a63774e88de55b2f3bde07068875c6e6489c47787d1f5cfddceff0213429c3` |
| positions-closed-manual.json | socket | 'positions' from the step that closed the short (MANUAL) | — | 2026-11-23T07:49:37Z | `01bbb56a4f5a5af93a216e5072c53f988b09e4ceec1cb4e3787fdace8b373c03` |
| positions-filled.json | socket | 'positions' from the step that filled both orders | — | 2026-11-23T07:49:33Z | `4258c49d4956b715eee25f81c65747d52664d87b5e5b6f415ec3088130066efa` |
| positions-pending.json | socket | 'positions' after the order | — | 2026-11-23T07:49:33Z | `d8eb60d0ed2a7901b175283801a5bb58f074c611ad1011ebfac646f16726aa2a` |
| state-calendar-after.json | socket | 'state' at 18:00 with the FOMC decision | — | 2026-11-23T07:49:44Z | `bf723b2290ca6fe0ab8996e7d55dc8538acff2a13d7e765b127ed4435a3d0490` |
| state-calendar-before.json | socket | 'state' at 17:58 before the FOMC decision at 18:00 (calendar covered, no event yet) | — | 2026-11-23T07:49:42Z | `5043ee87d02828ea505b7de749c20f45a9106bddbaf4e5291469e7f6d0800b51` |
| state-closed-trades.json | socket | 'state' with two closed trades and an open short | — | 2026-11-23T07:49:41Z | `f38078fd524ac60d402e52342b6652955ac335e374fddb5a6523772cd7f3796f` |
| state-end-of-data.json | socket | 'state' on reconnect at the end of the data | — | 2026-11-23T07:49:53Z | `68fe8c842864f019b1f5e0cb989f5155d61b116f72915e2ad3e2f1c3bb87cbf0` |
| state-no-session.json | socket | 'state' on connect without a session | — | 2026-11-23T07:49:19Z | `bda339da8bd567ff70e6c0353b141536dd5b18d603e699a479305f4b17f3a3fd` |
| state-open-positions.json | socket | 'state' with a long and a short open | — | 2026-11-23T07:49:37Z | `81be38057702c210e0506909d021bf00b981c62d382166ae38d1e8735b6ff063` |
| state-paused.json | socket | 'state' on connect: the new session, PAUSED | — | 2026-11-23T07:49:29Z | `1a0aa3c5414991a0746a20940cbedda1670760bed0d9a114082f589f9fbb84e8` |
| state-usdjpy-open-positions.json | socket | 'state' of USD/JPY (2016-06-24, Brexit vote night) with a long and a short open | — | 2026-11-23T07:49:52Z | `42380f3335480218c8136b1c60bd3e0d8c5292446d650be668c09e1ccdd8b064` |
| stats-200.json | rest | GET /sessions/:id/stats after the 22 trades | 200 | 2026-11-23T07:49:51Z | `6cf1298b0313813e58432e54ab031c79496a2706c3d28f28ecf581ecf180b247` |
| stats-200-empty.json | rest | GET /sessions/:id/stats before any trade | 200 | 2026-11-23T07:49:42Z | `83ae4d7783088b739285245b62d45a81a0d1b50d938d4d9ec08df0623aec75e6` |
| status-end-of-data.json | socket | 'status' at the end of the data (END_OF_DATA) | — | 2026-11-23T07:49:53Z | `cbe61c0fa7e0e09b82e33302a03d293dda78ba2f4b19840d37943ebaab6ff9f5` |
| status-paused-user.json | socket | 'status' after pause (USER) | — | 2026-11-23T07:49:40Z | `2ea5543654a7413775e27cd891c8215064f806018ef3f99063e9ce17bfc29362` |
| trades-200-page1.json | rest | GET /sessions/:id/trades: 20 of 21 trades closed in one minute | 200 | 2026-11-23T07:49:50Z | `e77e964054645f2c59f0ebccefce73571e55fb47fc109c2b7ffa249c5bac7df7` |
| trades-200-page2.json | rest | GET /sessions/:id/trades?cursor=: the last of the 21 | 200 | 2026-11-23T07:49:51Z | `44a21dc2aacf5e2c246d780ebde07b55574a53a6edc672be5edf1401632cb7ab` |
| trades-404.json | rest | GET /sessions/:id/trades of a session the user does not own | 404 | 2026-11-23T07:49:51Z | `62eb2ea9ab188a54b5df06f99bdf22d1996736c4d158f585a4f6850e674a2c2c` |
