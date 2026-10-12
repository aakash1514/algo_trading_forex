# Research page fixtures

Real `POST /api/research/ask` response bodies, saved byte for byte by
`apps/research-agent/scripts/record_ask_fixtures.py` (logged in through auth-service as research_demo;
no headers, no token). Nothing here is written or edited by hand.

`could-not-verify-no-llm.json` is the real service's response while it ran without an LLM key (the
GROQ_API_KEY line commented out in .env, no code change): the agent's model could not be built, so
the service answered `could_not_verify`. It has no tool calls.

| File | Question | HTTP | Type | Recorded (UTC) | Commit | sha256 |
|---|---|---|---|---|---|---|
| answer.json | What was GBP/USD's return in 2021 on daily bars? | 200 | answer | 2026-10-12T12:45:46+00:00 | `7b82530` | `38fb7509ec440b32203df67752a88474c9101a35460fd41d9c023ed440e036eb` |
| could-not-verify-no-llm.json | What was EUR/USD's return in 2022 on daily bars? | 200 | could_not_verify | 2026-10-12T12:48:50+00:00 | `7b82530` | `d6f8f801eac13bc32c4e314fe25c3392fc9cb65e5c426b45cbd9fd0c7e114ac4` |
| not-in-data.json | What was USD/CHF's return in 2020? | 200 | not_in_data | 2026-10-12T12:47:28+00:00 | `7b82530` | `63291a9c1bfda9d71b1544eca3f420655873b37630930ea732ab1d0aaf07a70c` |
| refusal.json | Which pair should I buy tomorrow? | 200 | refusal | 2026-10-12T12:46:36+00:00 | `7b82530` | `12d6077ba05c7aa2c518ffba6dd375cf4f023097a098e1c1447abe4948dc681c` |
| too-long.json | What was EUR/USD's return in 2022? What was EUR/USD's ret... (525 chars) | 422 | — | 2026-10-12T12:47:28+00:00 | `7b82530` | `eb7d68380368820e432282b6ae3174d28642b7fee8ea929849cad5788935825c` |
