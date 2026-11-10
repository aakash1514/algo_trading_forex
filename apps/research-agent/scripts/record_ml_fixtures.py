"""Records real ml-service responses for the ML tool tests (tests/fixtures/ml/).

Saves the response bodies only (no request or response headers, so no token). The access
token is minted with the shared JWT_ACCESS_SECRET in auth-service's format, like the tests.
ml-service must be running (npx nx serve ml-service).

    .venv/Scripts/python.exe scripts/record_ml_fixtures.py
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import httpx
import jwt

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from research_agent.auth import ACCESS_TOKEN_CLAIMS, access_secret
from research_agent.tools.ml import ml_base_url

OUT = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "ml"
# One test month per pair, each in a different test year (ml-service's parity months)
MONTHS = {
    "EUR_USD": ("2022-03-01", "2022-03-31"),
    "GBP_USD": ("2019-06-01", "2019-06-30"),
    "USD_JPY": ("2020-03-01", "2020-03-31"),
    "XAU_USD": ("2017-10-01", "2017-10-31"),
}


def main() -> None:
    now = int(time.time())
    claims = {
        **ACCESS_TOKEN_CLAIMS,
        "sub": "aaaaaaaa-0000-4000-8000-000000000005",
        "role": "TRADER",
        "iat": now,
        "exp": now + 300,
    }
    headers = {"Authorization": f"Bearer {jwt.encode(claims, access_secret(), algorithm='HS256')}"}
    OUT.mkdir(parents=True, exist_ok=True)
    with httpx.Client(base_url=ml_base_url(), timeout=120) as http:
        files: dict[str, tuple[str, dict[str, str] | None]] = {"evaluation.json": ("/evaluation", None)}
        for instrument, (start, end) in MONTHS.items():
            files[f"predictions-{instrument}-{start[:7]}.json"] = (
                f"/predictions/{instrument}",
                {"timeframe": "1h", "from": start, "to": end},
            )
        for name, (path, params) in files.items():
            r = http.get(path, params=params, headers=headers)
            r.raise_for_status()
            (OUT / name).write_text(json.dumps(r.json(), indent=1) + "\n", encoding="utf-8")
            print(f"{name}: {len(r.content)} bytes")


if __name__ == "__main__":
    main()
