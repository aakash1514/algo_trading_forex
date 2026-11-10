# Backlog

Known follow-ups that are deliberately not built yet. Each item says why it waits; the roadmap in `CLAUDE.md`
says when.

## Replay (steps 6b-1 and 6b-2)

1. **Keyboard shortcuts.** Space = play/pause, right arrow = step, and so on. The controls are buttons only today.
2. **Calendar events on the replay chart.** Needs historical calendar data for 2010–2022, which ForexEdge doesn't
   have (the calendar holds upcoming events only, from FOMC, ECB and Forex Factory).
3. **Detailed replay statistics.** Win rate, drawdown, average trade and so on. The end-of-session summary has the
   balance change, net P&L and the number of trades only.
4. **Paged closed-trade history.** The socket's state carries only the last 50 closed or cancelled entries, so the
   page lists those, and the end summary marks the trade count "+" when the state was at that cap. Needs a paginated
   trades endpoint on replay-service.
5. **No stop-out in replay.** As in the backtester, equity can fall below the margin in use. A stop-out rule would
   break the verified equivalence with the backtester, so it needs its own verification.

## Deployment (step 7)

6. **JWT expiry isn't enforced on open sockets** (replay-service and ws-gateway). A token is checked only at the
   handshake; an open socket keeps working after the access token expires. A reconnect needs a fresh token (the
   Replay page refreshes it).
7. **Health endpoints.** replay-service, market-service and domain-service have none (`/api` 404s); every service
   needs one for the host's probes.
