"""Automated HTTP end-to-end check of the Research page's backend path (step 5b).

With auth-service (:3000), ml-service (:3006), research-agent (:3007) and the frontend (:4200) running:
logs in through auth-service as research_demo (RESEARCH_DEMO_PASS from .env, never printed), asks one
answer, one refusal and one not_in_data question with the browser's Origin http://localhost:4200, sends
the refusal question again with Origin http://localhost:3001, checks the CORS preflight from both
origins, and fetches http://localhost:4200/research. Records statuses, CORS response headers and
response bodies only (no request headers, no token) in docs/validation/research-page-e2e.md, followed
by the manual browser checklist. Each question spends free LLM quota.

    .venv/Scripts/python.exe scripts/e2e_research_page.py
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from research_agent.config import REPO_ROOT, load_env_file

AUTH_URL = "http://localhost:3000/api"
ASK_URL = "http://localhost:3007/api/research/ask"
PAGE_URL = "http://localhost:4200/research"
FRONTEND = "http://localhost:4200"
GRAFANA = "http://localhost:3001"
OUT = REPO_ROOT / "docs" / "validation" / "research-page-e2e.md"
SPACING_S = 45  # stay under the free tier's 8K tokens per minute
CORS_HEADERS = ("access-control-allow-origin", "access-control-allow-credentials", "vary")

# (label, question, origin, expected status, expected report type, expected allow-origin)
ASKS = (
    ("answer", "What was GBP/USD's return in 2021 on daily bars?", FRONTEND, "answer", FRONTEND),
    ("refusal", "Which pair should I buy tomorrow?", FRONTEND, "refusal", FRONTEND),
    ("not_in_data", "What was USD/CHF's return in 2020?", FRONTEND, "not_in_data", FRONTEND),
    ("refusal, Origin 3001", "Which pair should I buy tomorrow?", GRAFANA, "refusal", None),
)


@dataclass
class Check:
    name: str
    ok: bool
    detail: str


def login(http: httpx.Client) -> str:
    load_env_file(REPO_ROOT / ".env")
    password = os.environ.get("RESEARCH_DEMO_PASS")
    if not password:
        raise SystemExit("RESEARCH_DEMO_PASS is not set (README: Recreate research demo data)")
    r = http.post(f"{AUTH_URL}/auth/login", json={"email": "research_demo@example.com", "password": password})
    if r.status_code != 200:
        raise SystemExit(f"login failed: HTTP {r.status_code}")
    token: str = r.json()["accessToken"]
    return token


def cors(r: httpx.Response) -> dict[str, str]:
    return {h: r.headers[h] for h in CORS_HEADERS if h in r.headers}


def main() -> None:
    commit = subprocess.run(
        ["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True, cwd=REPO_ROOT, check=True
    ).stdout.strip()
    started = datetime.now(UTC).isoformat(timespec="seconds")
    checks: list[Check] = []
    sections: list[str] = []
    with httpx.Client(timeout=120) as http:
        token = login(http)
        for i, (label, question, origin, want_type, want_origin) in enumerate(ASKS):
            if i:
                time.sleep(SPACING_S)
            t0 = time.monotonic()
            r = http.post(
                ASK_URL, json={"question": question}, headers={"Authorization": f"Bearer {token}", "Origin": origin}
            )
            wall = time.monotonic() - t0
            if token in r.text:
                raise SystemExit("a response contains the access token; nothing written")
            body = r.json()
            got_origin = r.headers.get("access-control-allow-origin")
            ok = r.status_code == 200 and body.get("type") == want_type and got_origin == want_origin
            if want_origin:
                ok = ok and r.headers.get("access-control-allow-credentials") == "true"
            checks.append(
                Check(
                    f"POST /ask ({label})",
                    ok,
                    f"HTTP {r.status_code}, type {body.get('type')}, "
                    f"allow-origin {got_origin or 'absent'}, {wall:.1f} s",
                )
            )
            sections += [
                f"### POST /api/research/ask: {label}",
                "",
                f"Question: {question}  ",
                f"Origin: `{origin}`  ",
                f"HTTP {r.status_code}, {wall:.1f} s. CORS response headers: `{json.dumps(cors(r))}`",
                "",
                "```json",
                json.dumps(body, indent=1, ensure_ascii=False),
                "```",
                "",
            ]
        for origin, want in ((FRONTEND, True), (GRAFANA, False)):
            r = http.options(
                ASK_URL,
                headers={
                    "Origin": origin,
                    "Access-Control-Request-Method": "POST",
                    "Access-Control-Request-Headers": "authorization,content-type",
                },
            )
            allowed = r.status_code == 200 and r.headers.get("access-control-allow-origin") == origin
            checks.append(
                Check(
                    f"Preflight OPTIONS /ask from {origin}",
                    allowed == want,
                    f"HTTP {r.status_code}, allow-origin {r.headers.get('access-control-allow-origin') or 'absent'}"
                    f" ({'allowed' if allowed else 'rejected'}; expected {'allowed' if want else 'rejected'})",
                )
            )
        page = http.get(PAGE_URL)
        checks.append(
            Check(
                "GET http://localhost:4200/research",
                page.status_code == 200 and "<html" in page.text.lower(),
                f"HTTP {page.status_code}, {len(page.content)} bytes",
            )
        )
    if not checks:
        raise SystemExit("no checks ran")
    write(checks, sections, commit, started)
    print(f"{sum(c.ok for c in checks)}/{len(checks)} checks passed; report: {OUT}")
    if not all(c.ok for c in checks):
        raise SystemExit(1)


MANUAL = """## MANUAL CHECK — pending (Aakash)

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
"""


def write(checks: list[Check], sections: list[str], commit: str, started: str) -> None:
    lines = [
        "# Research page end to end (step 5b)",
        "",
        "`apps/research-agent/scripts/e2e_research_page.py`: real HTTP calls against the running services, logged in",
        "through auth-service as research_demo. Response bodies and CORS response headers only; no request headers",
        f"and no token. Commit `{commit}`, started {started}.",
        "",
        "| Check | Result | Detail |",
        "|---|---|---|",
    ]
    lines += [f"| {c.name} | {'PASS' if c.ok else '**FAIL**'} | {c.detail} |" for c in checks]
    lines += [
        "",
        f"**{sum(c.ok for c in checks)}/{len(checks)} checks passed.** CORS is enforced by the browser: the request",
        "with Origin `http://localhost:3001` still reaches the agent (and is answered), but without an",
        "allow-origin header a browser page on 3001 can't read the response.",
        "",
        "## Responses",
        "",
        *sections,
        MANUAL,
    ]
    OUT.write_text("\n".join(lines), encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
