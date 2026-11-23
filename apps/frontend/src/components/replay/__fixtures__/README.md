# Replay page fixtures

Real replay-service responses and socket events, recorded by
`tools/replay-verify/src/record-frontend-fixtures.ts` against the running auth-service and replay-service and the
imported Dukascopy history, at commit `aac87a6`, as the throwaway user `replayfixture_d18cbb83@example.com` (deleted
afterwards with `tools/ops/delete-verification-users.ts`). Nothing here is written or edited by hand; this README
is written by the recorder too.

- **REST** (kind rest): the response body byte for byte.
- **Socket** (kind socket): `JSON.stringify` of the payload socket.io-client delivered. Socket.IO sends JSON, so
  this is the received object, re-serialized compactly.

Sessions: EUR/USD from 2022-03-01 09:30 UTC on 1m (a long 0.1 lot with SL/TP 100 points from the bid, closed by
its SL; a short 0.2 closed manually; a cancelled order; ended with a short open), USD/JPY from 2016-06-23 22:00
UTC on 1h (a long and a short open on the Brexit-vote night), EUR/USD from 2022-03-16 17:58 UTC on 1m across
the FOMC decision at 18:00 (calendar; 21 trades closed in one minute for paging, a 22nd later; statistics), and
EUR/USD from 2022-12-30 20:30 UTC stepped to the end of the history. My replays: GBP/USD (a title with markup)
and XAU/USD sessions, opened and switched, renamed, a paused one refused for deletion and the USD/JPY one deleted,
then 16 more EUR/USD sessions for a second list page.

| File | Kind | What | HTTP | Recorded (UTC) | sha256 |
|---|---|---|---|---|---|
| account-after-order.json | socket | 'account' after the order | — | 2026-11-23T08:18:19Z | `92ecf5b276b6a0e383391aea6b288489406192486274a223de08fe8fd98ea88f` |
| bar-1m.json | socket | 'bar' after a step on 1m | — | 2026-11-23T08:18:19Z | `b7c24f11564e32d3902699ca3eb8b652ed1f534c655bec89065f3b16a3a4c5c4` |
| calendar-fomc.json | socket | 'calendar' from the step that reached the 18:00 FOMC decision | — | 2026-11-23T08:18:33Z | `7bb6a5201e2ae5c5ce78745655455235bdb815ea98a0770d16321f16758340a3` |
| cancel-200.json | rest | POST /orders/:id/cancel of a pending order | 200 | 2026-11-23T08:18:20Z | `e8f971b5d9f99545c0d2317bde0cb1184a5b46eda6a9caaea79c3f5bfad1199c` |
| close-200.json | rest | POST /positions/:id/close (pending until the next minute) | 200 | 2026-11-23T08:18:25Z | `3c7a28f2440d735bf956ac6c35a563842019d748147b6dcd5c261a78bbdbfa9c` |
| create-201.json | rest | POST /sessions {EUR_USD, 2022-03-01T09:30Z, 1m, 10000} | 201 | 2026-11-23T08:18:10Z | `04e4222e677f4fd61abd33356670cec1e5c87ce6cde2fdea90e5e4e5d988a42a` |
| delete-204.json | rest | DELETE /sessions/:id of an ENDED session (no body) | 204 | 2026-11-23T08:18:44Z | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| delete-409-paused.json | rest | DELETE /sessions/:id of a paused session | 409 | 2026-11-23T08:18:44Z | `6cc7767b2b8853cbffc2ee18c1794f1dd3402635254865fc0294e5f04ae2783b` |
| end-200.json | rest | POST /sessions/:id/end with one position open | 200 | 2026-11-23T08:18:30Z | `5bf327bb60dac6a256acbb6ec1f0723c550237f9d52b26e7acb4c5b4cda73ea6` |
| end-of-data.json | socket | 'endOfData' at the pair's last minute | — | 2026-11-23T08:18:43Z | `0fca2c5a19de4a56fdbe80526c488e8b71ed31636e323f74b35e26bbc0523759` |
| ended.json | socket | 'ended' after the end | — | 2026-11-23T08:18:30Z | `5bf327bb60dac6a256acbb6ec1f0723c550237f9d52b26e7acb4c5b4cda73ea6` |
| open-200-ended.json | rest | POST /sessions/:id/open of an ENDED session: read-only state up to its end | 200 | 2026-11-23T08:18:44Z | `57a7ed1d4d1093610159790354d73b4141da68ff1969daf50bea80718940f48f` |
| open-200-paused.json | rest | POST /sessions/:id/open of a paused session: its state, now the current one | 200 | 2026-11-23T08:18:44Z | `e9ec9eac5d90c5cf2c79a2faae225a48fa93a8fb75230737a52bc9a120c33746` |
| open-404.json | rest | POST /sessions/:id/open of a session the user does not own | 404 | 2026-11-23T08:18:44Z | `53257d7707bc29a6e44446368b4c7681ece615ecc8a278104222b5988b948b20` |
| order-201-pending.json | rest | POST /orders BUY 0.1 lots, SL bid-100 points, TP bid+100 points | 201 | 2026-11-23T08:18:19Z | `f7597dd01c6257ff39029294c27b1eba50df0d2bcbb6478f48a4f990da4365f3` |
| order-400-margin.json | rest | POST /orders BUY 100 lots on 10,000 USD | 400 | 2026-11-23T08:18:20Z | `8802eeb12888fc491b78054b06b0adb6d4b4fe5dfbce168ea273da403457f31f` |
| order-400-sl-side.json | rest | POST /orders BUY with the stop loss above the bid | 400 | 2026-11-23T08:18:20Z | `7ec8bd3e727a30f7394c0670ec643ac27b0257e214000af650cbf7f319c0f273` |
| positions-closed-later.json | socket | 'positions' from the step that closed a 22nd trade, after the pages were loaded | — | 2026-11-23T08:18:41Z | `f10f3a2e464f6f326f36231f2cbb7dc00f484389424895d0793cd81a233431f8` |
| positions-closed-level.json | socket | 'positions' when the long closed at its SL or TP while playing | — | 2026-11-23T08:18:28Z | `a1ad63f4712785577df6ab091f9e129a3d365c0cb8bf409d13a19057da10f102` |
| positions-closed-manual.json | socket | 'positions' from the step that closed the short (MANUAL) | — | 2026-11-23T08:18:25Z | `66ab0417b6d5a81eff10ab094320e73367b08ab3b4217b406e55cca087bf99f3` |
| positions-filled.json | socket | 'positions' from the step that filled both orders | — | 2026-11-23T08:18:21Z | `e76aec2fc5f0627ca41f811b2d153bcc8a6b64ff4b97ffc0df36729c5d856578` |
| positions-pending.json | socket | 'positions' after the order | — | 2026-11-23T08:18:19Z | `2ca291894fe682ed875135ad3dd239053cd78ca2666005c7e5a959424b5a26b0` |
| rename-200.json | rest | PATCH /sessions/:id with a title (trimmed by the server) | 200 | 2026-11-23T08:18:44Z | `72dc1f6fc101660c571560b64a8a82b7f9bd6d1742064365009d46c0853d238d` |
| rename-400-too-long.json | rest | PATCH /sessions/:id with 61 characters | 400 | 2026-11-23T08:18:44Z | `fba5b7a45ce0feff11f23fb5cc81fdb9de6dd3bea05f9e1608fadbe6ea3120b6` |
| sessions-200-page1.json | rest | GET /sessions: the first 20 of 21 sessions, last opened first | 200 | 2026-11-23T08:18:46Z | `270d154445c9f650a2e422e5483cb5e75118cc39a4dca9e56c4ec0e00795e4b8` |
| sessions-200-page2.json | rest | GET /sessions?cursor=: the last one | 200 | 2026-11-23T08:18:46Z | `b21d415d2126d744c6b76535bbf37dbb913c005a7cf80ca68cf5b0e3ccfc1f37` |
| state-before-switch.json | socket | 'state' on connect: the latest created session (XAU/USD), before another is opened | — | 2026-11-23T08:18:44Z | `93d202c22555cdd87b35805906c1f0ec5e1678d7808fbf07d704065924c91b61` |
| state-calendar-after.json | socket | 'state' at 18:00 with the FOMC decision | — | 2026-11-23T08:18:34Z | `c715f017442caed0cc26848f4264fcf19d0eb8113ce66cb2d854c429427c9966` |
| state-calendar-before.json | socket | 'state' at 17:58 before the FOMC decision at 18:00 (calendar covered, no event yet) | — | 2026-11-23T08:18:32Z | `ca5e23c329f13acd7e262a632a87fc782c7db750df5ae744ff715ffb6b811ad5` |
| state-closed-trades.json | socket | 'state' with two closed trades and an open short | — | 2026-11-23T08:18:30Z | `e57813d9483abfe02ce8abb258c5b19e5a90b4cee5798960575ff25fcaf38f3c` |
| state-end-of-data.json | socket | 'state' on reconnect at the end of the data | — | 2026-11-23T08:18:43Z | `ba585ee970c3ce37966a3019ccd6c6a604056acd8c3a7e5074169edf3653aa13` |
| state-no-session.json | socket | 'state' on connect without a session | — | 2026-11-23T08:18:09Z | `bda339da8bd567ff70e6c0353b141536dd5b18d603e699a479305f4b17f3a3fd` |
| state-open-positions.json | socket | 'state' with a long and a short open | — | 2026-11-23T08:18:25Z | `0a198de39e6d74f1d7e04850bbf787bf494e4e8cf66ced4508b657560b2e34ea` |
| state-paused.json | socket | 'state' on connect: the new session, PAUSED | — | 2026-11-23T08:18:16Z | `cae42baf92fc88396f487df77947d11c0c9dc5ffa840206231b80105a2a16892` |
| state-usdjpy-open-positions.json | socket | 'state' of USD/JPY (2016-06-24, Brexit vote night) with a long and a short open | — | 2026-11-23T08:18:43Z | `0f6b0b5f5d65f1b5c957bbf521f2cf97a9c663c31822337e80df9b9db5857843` |
| stats-200.json | rest | GET /sessions/:id/stats after the 22 trades | 200 | 2026-11-23T08:18:41Z | `80a479f1f60f9f151188358cefbbbf23517de41118c9dbdc5239403c783aa3b5` |
| stats-200-empty.json | rest | GET /sessions/:id/stats before any trade | 200 | 2026-11-23T08:18:32Z | `83ae4d7783088b739285245b62d45a81a0d1b50d938d4d9ec08df0623aec75e6` |
| status-end-of-data.json | socket | 'status' at the end of the data (END_OF_DATA) | — | 2026-11-23T08:18:43Z | `b0fd61628a98fbb3dd15de0f1b61a8ac3c22ebbd8f3a4010b092c76234d134a5` |
| status-paused-user.json | socket | 'status' after pause (USER) | — | 2026-11-23T08:18:28Z | `ef50be09d491ce099e97595378da5fba5261fb298d379d1410034d3ece8124d3` |
| switched.json | socket | 'switched' to the tab still showing the other session | — | 2026-11-23T08:18:44Z | `1365878c701fd6f04ae5184c92515265efa16786c6ca96f6de1962628fca7439` |
| trades-200-page1.json | rest | GET /sessions/:id/trades: 20 of 21 trades closed in one minute | 200 | 2026-11-23T08:18:41Z | `4a12970ff2065ade069b8e737f9a0720d28f0418c1bec2eedb135e8ef9a6e6b9` |
| trades-200-page2.json | rest | GET /sessions/:id/trades?cursor=: the last of the 21 | 200 | 2026-11-23T08:18:41Z | `61adf849e1bcbfadb4c6e0222d8fb6c09dd9c8701ee8129c2918e90d0c5dc6f1` |
| trades-404.json | rest | GET /sessions/:id/trades of a session the user does not own | 404 | 2026-11-23T08:18:41Z | `62eb2ea9ab188a54b5df06f99bdf22d1996736c4d158f585a4f6850e674a2c2c` |
