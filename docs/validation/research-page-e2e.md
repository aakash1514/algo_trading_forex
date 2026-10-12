# Research page end to end (step 5b)

`apps/research-agent/scripts/e2e_research_page.py`: real HTTP calls against the running services, logged in
through auth-service as research_demo. Response bodies and CORS response headers only; no request headers
and no token. Commit `14242c3`, started 2026-10-12T12:59:44+00:00.

| Check | Result | Detail |
|---|---|---|
| POST /ask (answer) | PASS | HTTP 200, type answer, allow-origin http://localhost:4200, 25.8 s |
| POST /ask (refusal) | PASS | HTTP 200, type refusal, allow-origin http://localhost:4200, 6.2 s |
| POST /ask (not_in_data) | PASS | HTTP 200, type not_in_data, allow-origin http://localhost:4200, 5.1 s |
| POST /ask (refusal, Origin 3001) | PASS | HTTP 200, type refusal, allow-origin absent, 5.5 s |
| Preflight OPTIONS /ask from http://localhost:4200 | PASS | HTTP 200, allow-origin http://localhost:4200 (allowed; expected allowed) |
| Preflight OPTIONS /ask from http://localhost:3001 | PASS | HTTP 400, allow-origin absent (rejected; expected rejected) |
| GET http://localhost:4200/research | PASS | HTTP 200, 9949 bytes |

**7/7 checks passed.** CORS is enforced by the browser: the request
with Origin `http://localhost:3001` still reaches the agent (and is answered), but without an
allow-origin header a browser page on 3001 can't read the response.

## Responses

### POST /api/research/ask: answer

Question: What was GBP/USD's return in 2021 on daily bars?  
Origin: `http://localhost:4200`  
HTTP 200, 25.8 s. CORS response headers: `{"access-control-allow-origin": "http://localhost:4200", "access-control-allow-credentials": "true", "vary": "Origin"}`

```json
{
 "type": "answer",
 "answer": "GBP/USD's return in 2021 on daily bars was -0.9625%.",
 "claims": [
  {
   "text": "GBP/USD return 2021 daily",
   "value": "-0.9625",
   "unit": "pct",
   "tool_call_id": "call_1"
  }
 ],
 "tool_calls": [
  {
   "id": "call_1",
   "name": "get_market_stats",
   "args": {
    "from_date": "2021-01-01",
    "pair": "GBP/USD",
    "timeframe": "1d",
    "to_date": "2021-12-31"
   },
   "ok": true,
   "result_truncated": "{\"pair\":\"GBP/USD\",\"timeframe\":\"1d\",\"from_date\":\"2021-01-01\",\"to_date\":\"2021-12-31\",\"first_bar_utc\":\"2021-01-03T22:00:00Z\",\"last_bar_utc\":\"2021-12-30T22:00:00Z\",\"price_decimals\":5,\"bars_count\":260,\"first_open_price\":1.365195,\"last_close_price\":1.352055,\"return_pct\":-0.9625,\"up_bars_count\":128,\"down_bars_count\":132,\"flat_bars_count\":0,\"high_price\":1.424935,\"high_time_utc\":\"2021-05-31T21:00:00Z\",\"low_price\":1.31615,\"low_time_utc\":\"2021-12-07T22:00:00Z\",\"avg_range_pips\":91.1975,\" ...[truncated: 129 of 609 chars omitted — the full result was used for verification]"
  }
 ],
 "data_ranges": [
  {
   "tool": "get_market_stats",
   "pair": "GBP/USD",
   "timeframe": "1d",
   "from_date": "2021-01-01",
   "to_date": "2021-12-31",
   "year": null,
   "month": null,
   "run_id": null
  }
 ],
 "disclaimer": "Historical analysis of ForexEdge's own data only; not financial advice, and nothing here is a signal to buy or sell.",
 "verification": {
  "ok": true,
  "failures": [],
  "claims_checked": 1,
  "numbers_checked": 1
 }
}
```

### POST /api/research/ask: refusal

Question: Which pair should I buy tomorrow?  
Origin: `http://localhost:4200`  
HTTP 200, 6.2 s. CORS response headers: `{"access-control-allow-origin": "http://localhost:4200", "access-control-allow-credentials": "true", "vary": "Origin"}`

```json
{
 "type": "refusal",
 "answer": "I cannot provide buy/sell recommendations or trading advice.",
 "claims": [],
 "tool_calls": [],
 "data_ranges": [],
 "disclaimer": "Historical analysis of ForexEdge's own data only; not financial advice, and nothing here is a signal to buy or sell.",
 "verification": {
  "ok": true,
  "failures": [],
  "claims_checked": 0,
  "numbers_checked": 0
 }
}
```

### POST /api/research/ask: not_in_data

Question: What was USD/CHF's return in 2020?  
Origin: `http://localhost:4200`  
HTTP 200, 5.1 s. CORS response headers: `{"access-control-allow-origin": "http://localhost:4200", "access-control-allow-credentials": "true", "vary": "Origin"}`

```json
{
 "type": "not_in_data",
 "answer": "The requested pair USD/CHF is not covered by the available data.",
 "claims": [],
 "tool_calls": [],
 "data_ranges": [],
 "disclaimer": "Historical analysis of ForexEdge's own data only; not financial advice, and nothing here is a signal to buy or sell.",
 "verification": {
  "ok": true,
  "failures": [],
  "claims_checked": 0,
  "numbers_checked": 0
 }
}
```

### POST /api/research/ask: refusal, Origin 3001

Question: Which pair should I buy tomorrow?  
Origin: `http://localhost:3001`  
HTTP 200, 5.5 s. CORS response headers: `{"access-control-allow-credentials": "true", "vary": "Origin"}`

```json
{
 "type": "refusal",
 "answer": "I’m sorry, but I can’t provide buy or sell recommendations.",
 "claims": [],
 "tool_calls": [],
 "data_ranges": [],
 "disclaimer": "Historical analysis of ForexEdge's own data only; not financial advice, and nothing here is a signal to buy or sell.",
 "verification": {
  "ok": true,
  "failures": [],
  "claims_checked": 0,
  "numbers_checked": 0
 }
}
```

## MANUAL CHECK — pending (Aakash)

**Not done yet.** The automated check above covers the HTTP path; the page in a real browser still needs a person.

1. Start Docker Desktop, then the infra: `docker compose -f infra/docker-compose.yml --env-file .env up -d`.
2. Start the services from the repo root, each in its own terminal (compiled mode for the Node service):
   - `npx nx build auth-service` then `node dist/apps/auth-service/main.js` (:3000)
   - `npx nx serve ml-service` (:3006)
   - `npx nx serve research-agent` (:3007; needs GROQ_API_KEY in `.env`)
   - `npx nx build frontend` then `npx nx run frontend:serve:production` (:4200)
3. Open http://localhost:4200/login and log in as `research_demo@example.com` with the password in
   `.env` (`RESEARCH_DEMO_PASS`).
4. Click the Research icon (⌕) in the left nav; the page is http://localhost:4200/research. The yellow
   disclaimer is visible before any question.
5. Ask these three questions, one at a time, waiting about a minute between them (free LLM quota):
   - "What was GBP/USD's return in 2021 on daily bars?" — expect an **Answer** panel with a green
     **verified** badge, the answer text, a claims table (claim, value `-0.9625`, unit `pct`, tool call
     `call_1`), "Data used" (get_market_stats GBP/USD 1d 2021-01-01 to 2021-12-31), a collapsed
     "Tool calls (1)" section, and the disclaimer.
   - "Which pair should I buy tomorrow?" — expect a neutral **Not answered** box with the refusal text
     and the disclaimer; no badge, no claims.
   - "What was USD/CHF's return in 2020?" — expect a neutral **Not in the data** box with the text and the
     disclaimer; no badge, no claims.
6. While a question runs, the button reads "Researching..." and is disabled, with the note that it can take
   up to about 90 seconds.
7. Type more than 500 characters: the counter turns red and the button stays disabled.
8. A `could_not_verify` result (for example with the GROQ_API_KEY line commented out and research-agent
   restarted; restore the line afterwards) shows only the yellow "Could not verify" warning and the
   disclaimer: no answer text and no claims.
9. Take screenshots of steps 5-8 and save the three `/ask` response bodies from DevTools (Network tab,
   Response; not the request headers), then mark this section done.
