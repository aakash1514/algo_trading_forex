# Replay page fixtures

Real replay-service responses and socket events, recorded by
`tools/replay-verify/src/record-frontend-fixtures.ts` against the running auth-service and replay-service and the
imported Dukascopy history, at commit `8b62ad2`, as the throwaway user `replayfixture_137f9cb7@example.com` (deleted
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
| account-after-order.json | socket | 'account' after the order | — | 2026-11-23T05:24:44Z | `3d1daf2ee11e062e975f2cf647d50ba98e7acd31c798d2cf86de4d6cde0b5a97` |
| bar-1m.json | socket | 'bar' after a step on 1m | — | 2026-11-23T05:24:44Z | `b9b7d91ab190df179d52042be1b78398257482325026b730d0405fc6318dd33d` |
| calendar-fomc.json | socket | 'calendar' from the step that reached the 18:00 FOMC decision | — | 2026-11-23T05:24:59Z | `17c0d75796a6923ddbcae6e46efcd82b471df6383ca4f03eead82af1458263b0` |
| cancel-200.json | rest | POST /orders/:id/cancel of a pending order | 200 | 2026-11-23T05:24:45Z | `051c2f930dfec0e61e4e0440e65717fc4a6964be1eb205c4d5fb90e5b1e59e8d` |
| close-200.json | rest | POST /positions/:id/close (pending until the next minute) | 200 | 2026-11-23T05:24:50Z | `0665868877d8e6dc75229e486e0390872000472eabb783c520f6c8fe88a0da94` |
| create-201.json | rest | POST /sessions {EUR_USD, 2022-03-01T09:30Z, 1m, 10000} | 201 | 2026-11-23T05:24:41Z | `f436abe10de79ef0525493726cc9be2e59d07bdf662fb92baa353367caf3810e` |
| create-409.json | rest | POST /sessions while one is active | 409 | 2026-11-23T05:24:41Z | `c117648c7cd45d0dcb8716323e890c4a2258993dcd31df645f409fd9e0fe0be4` |
| end-200.json | rest | POST /sessions/active/end with one position open | 200 | 2026-11-23T05:24:56Z | `5118b912e2a778b2f90dfec731ecb9c0e62d5f3332071d84287f617d5c3182f6` |
| end-of-data.json | socket | 'endOfData' at the pair's last minute | — | 2026-11-23T05:25:20Z | `51d6ab75b8b9973a00676615186e833397e14c88fb42ba281cefbecb7e4ab19e` |
| ended.json | socket | 'ended' after the end | — | 2026-11-23T05:24:56Z | `5118b912e2a778b2f90dfec731ecb9c0e62d5f3332071d84287f617d5c3182f6` |
| order-201-pending.json | rest | POST /orders BUY 0.1 lots, SL bid-100 points, TP bid+100 points | 201 | 2026-11-23T05:24:44Z | `030fd4ffeade8c5c2328d02250e7ab4fb7288ad5048997b8ed4c2985e37f2c9b` |
| order-400-margin.json | rest | POST /orders BUY 100 lots on 10,000 USD | 400 | 2026-11-23T05:24:45Z | `8802eeb12888fc491b78054b06b0adb6d4b4fe5dfbce168ea273da403457f31f` |
| order-400-sl-side.json | rest | POST /orders BUY with the stop loss above the bid | 400 | 2026-11-23T05:24:44Z | `7ec8bd3e727a30f7394c0670ec643ac27b0257e214000af650cbf7f319c0f273` |
| positions-closed-later.json | socket | 'positions' from the step that closed a 22nd trade, after the pages were loaded | — | 2026-11-23T05:25:13Z | `c0430dbdd98c43531b86fc634710ae7d57389ec673768ffa94317924e231950a` |
| positions-closed-level.json | socket | 'positions' when the long closed at its SL or TP while playing | — | 2026-11-23T05:24:54Z | `9ac688aa85ec5bb17894c4c4366504eca4ff0d6b55b0c2564a767501815790be` |
| positions-closed-manual.json | socket | 'positions' from the step that closed the short (MANUAL) | — | 2026-11-23T05:24:51Z | `86774998bd53485f79a645ce6082ad67cb2eef48001f0f7f61e48007ef90175f` |
| positions-filled.json | socket | 'positions' from the step that filled both orders | — | 2026-11-23T05:24:45Z | `385af117c53c6d5365d42b638a979f706c2815deb35f236f0a7946b36f15a246` |
| positions-pending.json | socket | 'positions' after the order | — | 2026-11-23T05:24:44Z | `53ff5ad9d8671e03c9accefddd7f5fd3949b8a7ebd65b6558f363a703c154716` |
| state-calendar-after.json | socket | 'state' at 18:00 with the FOMC decision | — | 2026-11-23T05:25:00Z | `b82cee93ebd53fb049123a484cc9ec9458f8fa5784cbd97f1360722181ea218a` |
| state-calendar-before.json | socket | 'state' at 17:58 before the FOMC decision at 18:00 (calendar covered, no event yet) | — | 2026-11-23T05:24:59Z | `523f3e7b252fe78d5dfad289405fa68e18c7690a7da61ed856176b86ecdbad63` |
| state-closed-trades.json | socket | 'state' with two closed trades and an open short | — | 2026-11-23T05:24:56Z | `6599ff6621dd4cfa95d95e5d853c6e5fe01c1dd9d5d5762a6bb6c1d14123590c` |
| state-end-of-data.json | socket | 'state' on reconnect at the end of the data | — | 2026-11-23T05:25:20Z | `c78dd0e91d579f74ce01f0cb8ce3f65361d8fb67078c07ac88a9a9c2e9a3ddef` |
| state-no-session.json | socket | 'state' on connect without a session | — | 2026-11-23T05:24:41Z | `bda339da8bd567ff70e6c0353b141536dd5b18d603e699a479305f4b17f3a3fd` |
| state-open-positions.json | socket | 'state' with a long and a short open | — | 2026-11-23T05:24:50Z | `6662a3d7c9e19cfcc647ff307d8b0b04c647c6221537d26fc30e3c7acb5d6f69` |
| state-paused.json | socket | 'state' on connect: the new session, PAUSED | — | 2026-11-23T05:24:42Z | `dcb40146f9c8d4456755a4282d2334d3f175bb628727170446864bc98b0a69af` |
| state-usdjpy-open-positions.json | socket | 'state' of USD/JPY (2016-06-24, Brexit vote night) with a long and a short open | — | 2026-11-23T05:25:18Z | `f26436c5403f9e1120f6081a38f93cabbbf4308d1ec9c2409a4530a073815b4f` |
| stats-200.json | rest | GET /sessions/:id/stats after the 22 trades | 200 | 2026-11-23T05:25:13Z | `becbdfc2371b0129e6ffdf3691dc335ef321ee94403b447a2a1095b427d7fa1f` |
| stats-200-empty.json | rest | GET /sessions/:id/stats before any trade | 200 | 2026-11-23T05:24:59Z | `83ae4d7783088b739285245b62d45a81a0d1b50d938d4d9ec08df0623aec75e6` |
| status-end-of-data.json | socket | 'status' at the end of the data (END_OF_DATA) | — | 2026-11-23T05:25:20Z | `56d38e1341ac0a78e2dbec98004b52cf90fc3128985043a448d877805ea9bf6b` |
| status-paused-user.json | socket | 'status' after pause (USER) | — | 2026-11-23T05:24:54Z | `189b28b943e4f5481622560cd9162f4154ea1c42ee0df0d90c0beb3211e58758` |
| trades-200-page1.json | rest | GET /sessions/:id/trades: 20 of 21 trades closed in one minute | 200 | 2026-11-23T05:25:12Z | `ab89dfe354b140c690484ad011fae269d8c36aef104a46d2f4031b624fd076a2` |
| trades-200-page2.json | rest | GET /sessions/:id/trades?cursor=: the last of the 21 | 200 | 2026-11-23T05:25:12Z | `38629f95842938a6d8a00be1f8de27e8e12ff906ed8e6daadcaf4622662c7081` |
| trades-404.json | rest | GET /sessions/:id/trades of a session the user does not own | 404 | 2026-11-23T05:25:13Z | `62eb2ea9ab188a54b5df06f99bdf22d1996736c4d158f585a4f6850e674a2c2c` |
