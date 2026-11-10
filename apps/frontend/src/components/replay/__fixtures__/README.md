# Replay page fixtures

Real replay-service responses and socket events, recorded by
`tools/replay-verify/src/record-frontend-fixtures.ts` against the running auth-service and replay-service and the
imported Dukascopy history, at commit `dfce1cf` (step 6b-2), as the throwaway user `replayfixture_b608e584@example.com` (deleted
afterwards with `tools/ops/delete-verification-users.ts`). Nothing here is written or edited by hand; this README
is written by the recorder too.

- **REST** (kind rest): the response body byte for byte.
- **Socket** (kind socket): `JSON.stringify` of the payload socket.io-client delivered. Socket.IO sends JSON, so
  this is the received object, re-serialized compactly.

Sessions: EUR/USD from 2022-03-01 09:30 UTC on 1m (a long 0.1 lot with SL/TP 100 points from the bid, closed by
its SL; a short 0.2 closed manually; a cancelled order; ended with a short open), USD/JPY from 2016-06-23 22:00
UTC on 1h (a long and a short open on the Brexit-vote night), and EUR/USD from 2022-12-30 20:30 UTC stepped to
the end of the history.

| File | Kind | What | HTTP | Recorded (UTC) | sha256 |
|---|---|---|---|---|---|
| account-after-order.json | socket | 'account' after the order | — | 2026-11-09T20:33:28Z | `3d1daf2ee11e062e975f2cf647d50ba98e7acd31c798d2cf86de4d6cde0b5a97` |
| bar-1m.json | socket | 'bar' after a step on 1m | — | 2026-11-09T20:33:28Z | `ea26489d527ede1bc50c6339b738d36f8b0054a3a4f98f86cf6c7ba73c761c3f` |
| cancel-200.json | rest | POST /orders/:id/cancel of a pending order | 200 | 2026-11-09T20:33:28Z | `48d2d18bfa1861426b38deb0baa3c31bbee5502caa60ae1bbb1b43c71123d5df` |
| close-200.json | rest | POST /positions/:id/close (pending until the next minute) | 200 | 2026-11-09T20:33:30Z | `e652ccfc324ff8f52d872d8bbf7ddc79a38c67ae84275804bd4cdbab19e12a24` |
| create-201.json | rest | POST /sessions {EUR_USD, 2022-03-01T09:30Z, 1m, 10000} | 201 | 2026-11-09T20:33:25Z | `d5a21853a565f831faf28332348bb0e589957b3051221b8ee3979a364ff2d871` |
| create-409.json | rest | POST /sessions while one is active | 409 | 2026-11-09T20:33:25Z | `938e8ff9c13763cb9a603eafe78a52f7d9371afe466fbc02109d12ccd1fd686c` |
| end-200.json | rest | POST /sessions/active/end with one position open | 200 | 2026-11-09T20:33:33Z | `6b94822ae0bd847753d3d80e763d0b32ed1915f4ef2b5340ee15e825f61d65c3` |
| end-of-data.json | socket | 'endOfData' at the pair's last minute | — | 2026-11-09T20:33:34Z | `b80a37000df9c1cc39711357ca128bce8f42c652d4d48bb85cff4f3410e22d7f` |
| ended.json | socket | 'ended' after the end | — | 2026-11-09T20:33:33Z | `6b94822ae0bd847753d3d80e763d0b32ed1915f4ef2b5340ee15e825f61d65c3` |
| order-201-pending.json | rest | POST /orders BUY 0.1 lots, SL bid-100 points, TP bid+100 points | 201 | 2026-11-09T20:33:28Z | `6165ee20d3d0419cf7407601d5b9218f51e1cc69030a3de1cb9488fa28da3f20` |
| order-400-margin.json | rest | POST /orders BUY 100 lots on 10,000 USD | 400 | 2026-11-09T20:33:28Z | `8802eeb12888fc491b78054b06b0adb6d4b4fe5dfbce168ea273da403457f31f` |
| order-400-sl-side.json | rest | POST /orders BUY with the stop loss above the bid | 400 | 2026-11-09T20:33:28Z | `7ec8bd3e727a30f7394c0670ec643ac27b0257e214000af650cbf7f319c0f273` |
| positions-closed-level.json | socket | 'positions' when the long closed at its SL or TP while playing | — | 2026-11-09T20:33:32Z | `d7e6d7042c7f4f29ac2fcd41aa04bd5bd51158e83eaee4b013406babb8bd9afc` |
| positions-closed-manual.json | socket | 'positions' from the step that closed the short (MANUAL) | — | 2026-11-09T20:33:30Z | `0ce7cc3dd1680fbb08283e22d4f539953e4fc57cc571598badf6eb956e0e1313` |
| positions-filled.json | socket | 'positions' from the step that filled both orders | — | 2026-11-09T20:33:28Z | `e27ed209f03ab63b104584e7938756dbe31d1070aaae546abd801de7d20a256a` |
| positions-pending.json | socket | 'positions' after the order | — | 2026-11-09T20:33:28Z | `28e93162738c8cdb5039cb355aa40e8305a83d0c2346ac106adc5b55fc8c3ca9` |
| state-closed-trades.json | socket | 'state' with two closed trades and an open short | — | 2026-11-09T20:33:33Z | `635ca8c405a87012aa7d828f01a351794544ea08d2ea371f518eeab282d271d5` |
| state-end-of-data.json | socket | 'state' on reconnect at the end of the data | — | 2026-11-09T20:33:34Z | `7efa980ffb5c5ea5afdf22ab6e114bc960d2d0fa820f9d033b8c10333f71aaef` |
| state-no-session.json | socket | 'state' on connect without a session | — | 2026-11-09T20:33:25Z | `bda339da8bd567ff70e6c0353b141536dd5b18d603e699a479305f4b17f3a3fd` |
| state-open-positions.json | socket | 'state' with a long and a short open | — | 2026-11-09T20:33:29Z | `7b53c74c7483f998565e839a2a0b9bf89417e9f0f7151a5d29cfd721ddf61a99` |
| state-paused.json | socket | 'state' on connect: the new session, PAUSED | — | 2026-11-09T20:33:27Z | `6f20e04983571ec0cce71e8982a9cf3360536d7fff264b0b812e85cb4a437c91` |
| state-usdjpy-open-positions.json | socket | 'state' of USD/JPY (2016-06-24, Brexit vote night) with a long and a short open | — | 2026-11-09T20:33:33Z | `f6192e4b2684fab5998631ed5fdd12e5ffa83e9c0e7565ae92009d8b0e2a8716` |
| status-end-of-data.json | socket | 'status' at the end of the data (END_OF_DATA) | — | 2026-11-09T20:33:34Z | `a318ab3255e31181f8110e7f43bdc20a3952eaae86e7b9ee3bd9dc0de0459715` |
| status-paused-user.json | socket | 'status' after pause (USER) | — | 2026-11-09T20:33:32Z | `a312d3b5ab802381942d92c18c50f7225cbe7cd1086b53c19e87ef383ab49fe6` |
