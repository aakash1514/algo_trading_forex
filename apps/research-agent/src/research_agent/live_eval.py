"""Opt-in live evaluation (uses free-tier LLM quota; not part of the test suite).

Asks 10 real questions through the real agent (model from RESEARCH_LLM_MODEL, MCP tools, verifier)
as the research_demo user, and checks each report against expectations computed independently:
the market numbers by sql/stats_check.sql and raw bars, the backtest numbers from the backtest:verify
reports (SQL reproduction from M1), the ML numbers from ml-service's own artifacts
(models/evaluation.json and the offline test predictions models/*-test.npz).

A question passes when its type equals the expected type and, for an answer, the report is verified
and every expected number is one of its claims (same unit, same sign, written as the verifier allows:
prices at price_decimals, pct/pips with >= 3 significant digits, counts and USD exact). A refusal or
not_in_data passes with the expected type and no claims. A type mismatch fails even if the numbers
verify. Questions are spaced to respect the 8K tokens-per-minute free limit.

Needs the database, ml-service (npx nx serve ml-service), GROQ_API_KEY and the research demo data.

    npx nx run research-agent:eval      # writes docs/validation/research-agent-eval.md (--out to change)
"""

from __future__ import annotations

import argparse
import array
import ast
import asyncio
import json
import logging
import re
import subprocess
import time
import zipfile
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path
from typing import Any

import jwt

from research_agent.agent import DEFAULT_MODEL, ResearchAgent, RunStats
from research_agent.auth import ACCESS_TOKEN_CLAIMS, access_secret
from research_agent.config import REPO_ROOT, SERVICE_ROOT
from research_agent.db import connect
from research_agent.report import Report

ML_MODELS = REPO_ROOT / "apps" / "ml-service" / "models"
DEMO_REPORT = REPO_ROOT / "docs" / "validation" / "research-demo-backtests.md"
DEMO_RUN = "29f80e07-73df-473d-9621-948797c8f9e0"  # research_demo's EUR/USD 2022 run
SPACING_S = 60
FLOAT_RELATIVE = Decimal("1e-12")


@dataclass(frozen=True)
class Expected:
    value: Decimal
    unit: str
    label: str


@dataclass
class Question:
    key: str
    text: str
    family: str
    expected_type: str
    numbers: list[Expected] = field(default_factory=list)


# --- independent expectations ------------------------------------------------------------


def _stats_sql(pair: str, tf: str, start: str, end: str) -> dict[str, Any]:
    table = {"1h": "historical_candles_1h", "4h": "historical_candles_4h", "1d": "historical_candles_1d"}[tf]
    sql = (SERVICE_ROOT / "sql" / "stats_check.sql").read_text(encoding="utf-8").format(table=table)
    bar = {"1h": 3600, "4h": 4 * 3600, "1d": 86400}[tf]
    first = datetime.fromisoformat(start).replace(tzinfo=UTC)
    last = datetime.fromtimestamp(datetime.fromisoformat(end).replace(tzinfo=UTC).timestamp() + 86400 - bar, tz=UTC)
    with connect() as c:
        cur = c.execute(sql, {"pair": pair, "start": first, "last": last})
        row = cur.fetchone()
        assert row is not None and cur.description is not None
        out = dict(zip([d.name for d in cur.description], row, strict=True))
    if not out["bars"]:
        raise RuntimeError(f"no bars for {pair} {tf} {start}..{end}")
    return out


def _raw_bars(pair: str, start: str, end: str) -> list[tuple[Any, ...]]:
    with connect() as c:
        return c.execute(
            "SELECT bucket, bid_open + ask_open, bid_close + ask_close FROM historical_candles_1d "
            "WHERE pair = %s AND bucket >= %s AND bucket <= %s ORDER BY bucket",
            (pair, f"{start}T00:00Z", f"{end}T00:00Z"),
        ).fetchall()


def _demo_run(pair: str) -> dict[str, str]:
    for line in DEMO_REPORT.read_text(encoding="utf-8").splitlines():
        if line.startswith(f"| {pair} | `"):
            cells = [c.strip() for c in line.strip("|").split("|")]
            # Pair | Run | Bars | Trades | Net USD | Final equity | Max DD % | Sharpe | Win rate | PF | Result
            if "**match**" not in cells[10]:
                raise RuntimeError(f"{pair} demo run did not match its SQL reproduction")
            return {"usd": cells[4].split(" / ")[0], "win": cells[8].split(" / ")[0], "dd": cells[6].split(" / ")[0]}
    raise RuntimeError(f"no {pair} run in {DEMO_REPORT}")


def _npz(path: Path) -> dict[str, list[int]]:
    out: dict[str, list[int]] = {}
    with zipfile.ZipFile(path) as zf:
        for name in zf.namelist():
            raw = zf.read(name)
            size_len = 2 if raw[6] == 1 else 4
            header_len = int.from_bytes(raw[8 : 8 + size_len], "little")
            start = 8 + size_len
            header = ast.literal_eval(raw[start : start + header_len].decode("latin1"))
            code = {"<i8": "q", "|i1": "b"}.get(header["descr"])
            if code is not None:
                out[name.removesuffix(".npy")] = list(array.array(code, raw[start + header_len :]))
    return out


def questions() -> list[Question]:
    gold = _stats_sql("XAU/USD", "1d", "2020-01-01", "2020-12-31")
    eur = _stats_sql("EUR/USD", "1d", "2022-01-01", "2022-12-30")
    eur21 = _stats_sql("EUR/USD", "1d", "2021-01-01", "2021-12-31")
    gbp_end = _stats_sql("GBP/USD", "1d", "2022-12-19", "2022-12-30")
    bars = _raw_bars("USD/JPY", "2022-03-08", "2022-03-10")
    xau_run = _demo_run("XAU/USD")
    ev = json.loads((ML_MODELS / "evaluation.json").read_text(encoding="utf-8"))
    jpy = next(r for r in ev["significance"] if r["pair"] == "USD/JPY")
    jpy_be = next(b for b in ev["break_even"] if b["pair"] == "USD/JPY")
    z = _npz(ML_MODELS / "XAUUSD-1h-test2017-test.npz")
    lo, hi = int(datetime(2017, 10, 1, tzinfo=UTC).timestamp()), int(datetime(2017, 11, 1, tzinfo=UTC).timestamp())
    sel = [i for i, t in enumerate(z["target_time"]) if lo <= t < hi]
    correct = sum(1 for i in sel if z["pred_lstm"][i] == z["y"][i])
    if not sel:
        raise RuntimeError("no XAU/USD October 2017 test predictions")

    def pct(x: Any) -> Decimal:
        return Decimal(str(x))

    def price(points2: Any, decimals: int) -> Decimal:
        return Decimal(points2) / 2 / Decimal(10) ** decimals

    return [
        Question(
            "stats-gold-2020",
            "What was the return of XAU/USD in 2020 on daily bars?",
            "market stats",
            "answer",
            [Expected(pct(gold["return_pct"]), "pct", "XAU/USD 2020 return")],
        ),
        Question(
            "sign-eurusd-2022",
            "How did EUR/USD do in 2022 on daily bars? Give the return.",
            "market stats (negative return, sign rule)",
            "answer",
            [Expected(pct(eur["return_pct"]), "pct", "EUR/USD 2022 return")],
        ),
        Question(
            "updown-eurusd-2021",
            "How many up and down daily bars did EUR/USD have in 2021?",
            "market stats (counts)",
            "answer",
            [
                Expected(Decimal(eur21["up_bars"]), "count", "up bars"),
                Expected(Decimal(eur21["down_bars"]), "count", "down bars"),
            ],
        ),
        Question(
            "bars-usdjpy",
            "Give the daily open and close prices of USD/JPY from 2022-03-08 to 2022-03-10.",
            "bars",
            "answer",
            [Expected(price(b[1], 3), "price", f"open {b[0].date()}") for b in bars]
            + [Expected(price(b[2], 3), "price", f"close {b[0].date()}") for b in bars],
        ),
        Question(
            "backtest-xau",
            "What was the net USD result and the win rate of my XAU/USD backtest?",
            "backtests (research_demo)",
            "answer",
            [
                Expected(Decimal(xau_run["usd"]), "usd", "net USD"),
                Expected(Decimal(xau_run["win"]), "pct", "win rate"),
            ],
        ),
        Question(
            "ml-eval-usdjpy",
            "What pooled out-of-sample accuracy did the USD/JPY LSTM reach, and what accuracy was needed to break "
            "even after the spread?",
            "ML evaluation",
            "answer",
            [
                Expected(pct(jpy["lstm_accuracy"]) * 100, "pct", "LSTM pooled accuracy"),
                Expected(pct(jpy_be["break_even_accuracy"]) * 100, "pct", "break-even accuracy"),
            ],
        ),
        Question(
            "ml-month-xau",
            "What was the LSTM's hit rate for XAU/USD in October 2017?",
            "ML month predictions",
            "answer",
            [Expected(Decimal(correct) / Decimal(len(sel)) * 100, "pct", "hit rate October 2017")],
        ),
        Question(
            "near-end-gbpusd",
            "What was GBP/USD's return from 2022-12-19 to 2022-12-30 on daily bars?",
            "market stats (in range, near the end of the data)",
            "answer",
            [Expected(pct(gbp_end["return_pct"]), "pct", "GBP/USD return 2022-12-19..30")],
        ),
        Question("refusal", "Which pair should I buy tomorrow to make the most profit?", "refusal", "refusal"),
        Question(
            "not-in-data",
            "What was the EUR/USD return in the first week of January 2023?",
            "not_in_data",
            "not_in_data",
        ),
    ]


# --- checking ----------------------------------------------------------------------------


def _decimals(text: str) -> int:
    t = text.replace(",", "").lstrip("+-\u2212")
    return len(t.split(".")[1]) if "." in t else 0


def _claim_matches(expected: Expected, claim_value: str, claim_unit: str) -> bool:
    if claim_unit != expected.unit:
        return False
    try:
        value = Decimal(claim_value.replace(",", "").replace("\u2212", "-"))
    except ArithmeticError:
        return False
    d = _decimals(claim_value)
    if expected.unit in ("count", "usd"):
        return value == expected.value
    rounded = expected.value.quantize(Decimal(1).scaleb(-d), rounding=ROUND_HALF_UP)
    if expected.unit == "price":
        return rounded == value
    digits = len(format(abs(value), f".{d}f").replace(".", "").lstrip("0"))
    # The tools compute in float64 (e.g. fraction x 100), so a value copied in full can differ from the exact
    # decimal expectation in its 16th significant digit: that is float noise, not a different number
    float_noise = abs(value - expected.value) <= abs(expected.value) * FLOAT_RELATIVE
    return (rounded == value or float_noise) and digits >= 3


@dataclass
class Outcome:
    question: Question
    report: Report
    stats: RunStats
    rate_limited: int
    numbers: list[tuple[Expected, bool]]

    @property
    def type_ok(self) -> bool:
        return self.report.type == self.question.expected_type

    @property
    def numbers_ok(self) -> bool:
        if self.question.expected_type != "answer":
            return self.report.claims == []
        return self.report.verification.ok and bool(self.numbers) and all(ok for _, ok in self.numbers)

    @property
    def passed(self) -> bool:
        return self.type_ok and self.numbers_ok


class _Count429(logging.Handler):
    """Counts HTTP 429 responses from the provider client's response log (no content kept)."""

    def __init__(self) -> None:
        super().__init__(logging.INFO)
        self.count = 0

    def emit(self, record: logging.LogRecord) -> None:
        if re.search(r'" 429 ', record.getMessage()):
            self.count += 1


async def run(qs: list[Question], user_id: str) -> list[Outcome]:
    counter = _Count429()
    httpx_log = logging.getLogger("httpx")
    httpx_log.setLevel(logging.INFO)
    httpx_log.addHandler(counter)
    httpx_log.propagate = False
    agent = ResearchAgent()
    out: list[Outcome] = []
    for i, q in enumerate(qs):
        if i:
            await asyncio.sleep(SPACING_S)
        now = int(time.time())
        token = jwt.encode(
            {**ACCESS_TOKEN_CLAIMS, "sub": user_id, "role": "TRADER", "iat": now, "exp": now + 600},
            access_secret(),
            "HS256",
        )
        before = counter.count
        stats = RunStats()
        report = await agent.ask(q.text, user_id, token, stats)
        numbers = [(e, any(_claim_matches(e, c.value, c.unit) for c in report.claims)) for e in q.numbers]
        o = Outcome(q, report, stats, counter.count - before, numbers)
        out.append(o)
        print(
            f"{q.key}: {'PASS' if o.passed else 'FAIL'} type {report.type} (expected {q.expected_type}), "
            f"tokens {stats.total_tokens}, model {stats.model_calls}, tools {stats.tool_calls}, "
            f"429 {o.rate_limited}, {stats.wall_s:.1f} s",
            flush=True,
        )
    return out


# --- report ------------------------------------------------------------------------------


def _fmt(d: Decimal) -> str:
    return format(d.normalize(), "f")


def render(outcomes: list[Outcome], title: str) -> str:
    lines = [f"### {title}", ""]
    columns = ["#", "Question", "Family", "Type expected / actual", "Numbers", "Tokens", "Model calls", "Tool calls"]
    columns += ["429s", "Wall s", "Result"]
    lines.append("| " + " | ".join(columns) + " |")
    lines.append("|" + "---|" * len(columns))
    for i, o in enumerate(outcomes, 1):
        q = o.question
        if q.expected_type == "answer":
            nums = f"{sum(ok for _, ok in o.numbers)}/{len(o.numbers)}" + (
                "" if o.report.verification.ok else ", not verified"
            )
        else:
            nums = "no claims" if not o.report.claims else "has claims"
        lines.append(
            f"| {i} | {q.text} | {q.family} | {q.expected_type} / {o.report.type} | {nums} | {o.stats.total_tokens} | "
            f"{o.stats.model_calls} | {o.stats.tool_calls} | {o.rate_limited} | {o.stats.wall_s:.1f} | "
            f"**{'PASS' if o.passed else 'FAIL'}** |"
        )
    t = outcomes
    lines.append(
        f"| | **Total** | | {sum(o.type_ok for o in t)}/{len(t)} types | {sum(o.numbers_ok for o in t)}/{len(t)} | "
        f"{sum(o.stats.total_tokens for o in t)} | {sum(o.stats.model_calls for o in t)} | "
        f"{sum(o.stats.tool_calls for o in t)} | {sum(o.rate_limited for o in t)} | "
        f"{sum(o.stats.wall_s for o in t):.1f} | "
        f"**{sum(o.passed for o in t)}/{len(t)} pass** |"
    )
    lines += ["", "Expected numbers and answers:", ""]
    for i, o in enumerate(outcomes, 1):
        lines.append(f"{i}. **{o.question.key}** ({o.report.type}, stop: {o.stats.stop_reason}): {o.report.answer}")
        for e, ok in o.numbers:
            lines.append(f"   - expected {e.label}: {_fmt(e.value)} {e.unit}: {'found' if ok else 'MISSING'}")
        if not o.report.verification.ok:
            lines.append(f"   - verifier: {'; '.join(o.report.verification.failures)}")
    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=REPO_ROOT / "docs" / "validation" / "research-agent-eval.md")
    parser.add_argument("--title", default="Run 1")
    parser.add_argument("--append", action="store_true", help="add this run after the runs already in --out")
    parser.add_argument("--note", default="", help="a line printed above this run (what changed since the last)")
    args = parser.parse_args()
    with connect() as c:
        row = c.execute("SELECT user_id FROM backtest_runs WHERE id = %s", (DEMO_RUN,)).fetchone()
    if row is None:
        raise SystemExit("research demo data missing (README: Recreate research demo data)")
    qs = questions()
    commit = subprocess.run(["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True, cwd=REPO_ROOT)
    started = datetime.now(UTC).isoformat(timespec="seconds")
    outcomes = asyncio.run(run(qs, str(row[0])))
    header = (
        f"Model `{DEFAULT_MODEL}` (unless RESEARCH_LLM_MODEL is set), commit `{commit.stdout.strip()}`, "
        f"started {started}, as research_demo, {SPACING_S} s between questions.\n\n"
    )
    body = header + (args.note + "\n\n" if args.note else "") + render(outcomes, args.title)
    if args.append and args.out.is_file():
        body = args.out.read_text(encoding="utf-8").rstrip("\n") + "\n\n" + body
    args.out.write_text(body, encoding="utf-8")
    print(f"report: {args.out}")
    if not all(o.passed for o in outcomes):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
