"""Records real POST /api/research/ask responses for the frontend's Research page tests
(apps/frontend/src/components/research/__fixtures__/).

Logs in through auth-service as research_demo (password from RESEARCH_DEMO_PASS in .env, never
printed), asks each question once through the running research-agent and saves the response body
byte for byte (no request or response headers, so no token). manifest.json and README.md list the
question, status, report type, time, commit and sha256 of every file. auth-service (:3000) and
research-agent (:3007) must be running. Each answered question spends free LLM quota.

    .venv/Scripts/python.exe scripts/record_ask_fixtures.py answer refusal not-in-data too-long
    # with the GROQ_API_KEY line commented out in .env and research-agent restarted:
    .venv/Scripts/python.exe scripts/record_ask_fixtures.py could-not-verify-no-llm
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from research_agent.config import REPO_ROOT, load_env_file

OUT = REPO_ROOT / "apps" / "frontend" / "src" / "components" / "research" / "__fixtures__"
AUTH_URL = "http://localhost:3000/api"
ASK_URL = "http://localhost:3007/api/research/ask"
SPACING_S = 45  # stay under the free tier's 8K tokens per minute

QUESTIONS = {
    "answer": "What was GBP/USD's return in 2021 on daily bars?",
    "refusal": "Which pair should I buy tomorrow?",
    "not-in-data": "What was USD/CHF's return in 2020?",
    # rejected by the 500-character cap before the agent runs (no LLM call)
    "too-long": "What was EUR/USD's return in 2022? " * 15,
    "could-not-verify-no-llm": "What was EUR/USD's return in 2022 on daily bars?",
}


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


def main(names: list[str]) -> None:
    unknown = [n for n in names if n not in QUESTIONS]
    if not names or unknown:
        raise SystemExit(f"name one or more of {', '.join(QUESTIONS)}")
    commit = subprocess.run(
        ["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True, cwd=REPO_ROOT, check=True
    ).stdout.strip()
    OUT.mkdir(parents=True, exist_ok=True)
    manifest_path = OUT / "manifest.json"
    manifest: dict[str, dict[str, object]] = (
        json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.is_file() else {}
    )
    with httpx.Client(timeout=120) as http:
        token = login(http)
        for i, name in enumerate(names):
            if i and name != "too-long":
                time.sleep(SPACING_S)
            question = QUESTIONS[name]
            r = http.post(ASK_URL, json={"question": question}, headers={"Authorization": f"Bearer {token}"})
            body = r.content
            if token.encode() in body:
                raise SystemExit("the response contains the access token; nothing saved")
            report_type = r.json().get("type") if r.status_code == 200 else None
            (OUT / f"{name}.json").write_bytes(body)
            manifest[name] = {
                "file": f"{name}.json",
                "question": question,
                "status": r.status_code,
                "type": report_type,
                "recorded_at": datetime.now(UTC).isoformat(timespec="seconds"),
                "commit": commit,
                "sha256": hashlib.sha256(body).hexdigest(),
            }
            print(f"{name}: HTTP {r.status_code} {report_type or ''}")
    manifest_path.write_text(json.dumps(manifest, indent=1, sort_keys=True) + "\n", encoding="utf-8", newline="\n")
    write_readme(manifest)


def write_readme(manifest: dict[str, dict[str, object]]) -> None:
    lines = [
        "# Research page fixtures",
        "",
        "Real `POST /api/research/ask` response bodies, saved byte for byte by",
        "`apps/research-agent/scripts/record_ask_fixtures.py` (logged in through auth-service as research_demo;",
        "no headers, no token). Nothing here is written or edited by hand.",
        "",
        "`could-not-verify-no-llm.json` is the real service's response while it ran without an LLM key (the",
        "GROQ_API_KEY line commented out in .env, no code change): the agent's model could not be built, so",
        "the service answered `could_not_verify`. It has no tool calls.",
        "",
        "| File | Question | HTTP | Type | Recorded (UTC) | Commit | sha256 |",
        "|---|---|---|---|---|---|---|",
    ]
    for m in sorted(manifest.values(), key=lambda m: str(m["file"])):
        q = str(m["question"])
        q = q if len(q) <= 60 else f"{q[:57]}... ({len(q)} chars)"
        lines.append(
            f"| {m['file']} | {q} | {m['status']} | {m['type'] or '—'} | {m['recorded_at']} | `{m['commit']}` | "
            f"`{m['sha256']}` |"
        )
    (OUT / "README.md").write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main(sys.argv[1:])
