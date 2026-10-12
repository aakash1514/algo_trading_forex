"""Deterministic verifier (no LLM): every number in the report must come from a tool result.

Claims. Each claim names a successful tool call; its value must match a numeric field of that
call's result whose unit suffix equals the claim's unit (domain.UNITS; a columnar result takes
the unit from its column names). Values are signed and are never compared by absolute value.
  price          equal to the field rounded half away from zero to the pair's price_decimals
                 (from the same result), and written with exactly that many decimals
  pct pips ratio p
                 equal to the field rounded half away from zero to the decimals written, and the
                 written value keeps at least 3 significant digits (or all of the field's, if fewer)
  count usd lots param
                 exactly equal
  There is no unit conversion: a percent claim must come from a _pct field.

Answer text. Every number in the answer must be one of the verified claims' values, with the same
unit when the text gives one (%, percent, pip(s), $, USD, price). Its sign is the written sign, or else
the closest direction word within the 3 words before it in the same clause (fell/declined/down/
lost/dropped make it negative, rose/gained/up/climbed/increased positive), else positive; a written sign that
contradicts the direction word fails. Not numbers: bare years 2010-2022, pair names, timeframes
(1h/4h/1d, H1/H4/D1, M1), and run ids; dates (YYYY-MM-DD, with an optional time) must appear in a
tool call's arguments or result.

Empty input fails: an answer needs at least one successful tool call and one claim. A refusal or
not_in_data answer must contain no claims and no numbers other than bare years (any 4-digit year 1900-2099
there, since it names what is missing, e.g. "2023 is not in the data"; a year is bare only when no unit
follows or precedes it: "2050 pips", "2019%", "$2020" or "2050 price" are numbers)."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any

from research_agent.domain import unit_of
from research_agent.report import Claim, Verification

EXACT_UNITS = {"count", "usd", "lots", "param"}
ROUNDED_UNITS = {"pct", "pips", "ratio", "p"}
MIN_SIGNIFICANT = 3
DATA_YEARS = (2010, 2022)  # bare years in an answer
ANY_YEARS = (1900, 2099)  # bare years in a refusal or not_in_data answer

NEGATIVE_WORDS = {"fell", "declined", "down", "lost", "dropped"}
POSITIVE_WORDS = {"rose", "gained", "up", "climbed", "increased"}
DIRECTION_WINDOW = 3

_UUID = re.compile(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b")
_DATE = re.compile(r"\b(\d{4}-\d{2}-\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2})?Z?)?\b")
_TIME = re.compile(r"\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:UTC|Z)?\b")
_PAIR = re.compile(r"\b[A-Z]{3}/[A-Z]{3}\b|\b[A-Z]{3}_[A-Z]{3}\b")
_TIMEFRAME = re.compile(r"\b(?:[1-9]\d?[mhdw]|[HDM][1-9]\d?|[1-9]-?(?:hour|day|minute))\b", re.IGNORECASE)
_MODEL_ID = re.compile(r"\b[a-z]+(?:-[a-z]?\d+)+\b")  # e.g. lstm-h32-w32 (a config name, not a value)
_NUMBER = re.compile(
    r"(?P<sign>[+\-\u2212])?\s?(?P<dollar>\$)?(?P<num>\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)"
    r"(?P<suffix>\s?(?:%|percent\b|pips?\b|USD\b|price\b))?"
)
_WORD = re.compile(r"[A-Za-z]+")
_CLAUSE_BREAK = re.compile(r"\d|[,;:()!]|\.(?:\s|$)")


@dataclass(frozen=True)
class Leaf:
    unit: str
    value: Decimal
    path: str


@dataclass(frozen=True)
class CallResult:
    id: str
    name: str
    args: dict[str, Any]
    result: Any  # parsed JSON, the full result (not the truncated copy the model saw)

    @property
    def ok(self) -> bool:
        return not (isinstance(self.result, dict) and "error" in self.result)


def _decimal(v: object) -> Decimal | None:
    if isinstance(v, bool) or not isinstance(v, int | float):
        return None
    return Decimal(str(v))


def leaves(result: Any, path: str = "") -> list[Leaf]:
    """Numeric fields with a unit suffix, anywhere in a result."""
    out: list[Leaf] = []
    if isinstance(result, dict):
        cols = result.get("columns")
        rows = result.get("rows")
        if isinstance(cols, list) and isinstance(rows, list):
            for i, row in enumerate(rows):
                for col, v in zip(cols, row if isinstance(row, list) else [], strict=False):
                    unit, d = unit_of(str(col)), _decimal(v)
                    if unit and d is not None:
                        out.append(Leaf(unit, d, f"{path}rows[{i}].{col}"))
        for k, v in result.items():
            if k in ("columns", "rows") and isinstance(cols, list):
                continue
            unit, d = unit_of(str(k)), _decimal(v)
            if unit and d is not None:
                out.append(Leaf(unit, d, f"{path}{k}"))
            elif isinstance(v, dict | list):
                out.extend(leaves(v, f"{path}{k}."))
    elif isinstance(result, list):
        for i, v in enumerate(result):
            out.extend(leaves(v, f"{path}[{i}]."))
    return out


def _parse_value(text: str) -> tuple[Decimal, int] | None:
    """A written number -> (value, decimals written). Accepts a leading sign (incl. U+2212) and
    thousands separators."""
    t = text.strip().replace("\u2212", "-").replace(",", "")
    if not re.fullmatch(r"[+-]?\d+(?:\.\d+)?", t):
        return None
    try:
        v = Decimal(t)
    except InvalidOperation:
        return None
    return v, len(t.split(".")[1]) if "." in t else 0


def _significant(value: Decimal, decimals: int) -> int:
    """Significant digits of a value as written with that many decimals."""
    digits = format(abs(value), f".{decimals}f").replace(".", "").lstrip("0")
    return len(digits)


def _round(v: Decimal, decimals: int) -> Decimal:
    return v.quantize(Decimal(1).scaleb(-decimals), rounding=ROUND_HALF_UP)


def _matches(claim_value: Decimal, decimals: int, unit: str, leaf: Leaf, price_decimals: int | None) -> bool:
    if unit == "price":
        return price_decimals is not None and decimals == price_decimals and _round(leaf.value, decimals) == claim_value
    if unit in EXACT_UNITS:
        return leaf.value == claim_value
    if unit in ROUNDED_UNITS:
        leaf_digits = len(leaf.value.normalize().as_tuple().digits)
        if _significant(claim_value, decimals) < min(MIN_SIGNIFICANT, leaf_digits):
            return False
        return _round(leaf.value, decimals) == claim_value
    return False


def check_claim(claim: Claim, calls: dict[str, CallResult]) -> str | None:
    """None if the claim is backed by its tool call, else the reason."""
    call = calls.get(claim.tool_call_id)
    if call is None:
        return f"claim '{claim.text}' ({claim.value}): unknown tool call {claim.tool_call_id}"
    if not call.ok:
        return f"claim '{claim.text}' ({claim.value}): tool call {claim.tool_call_id} returned an error"
    parsed = _parse_value(claim.value)
    if parsed is None:
        return f"claim '{claim.text}': value {claim.value!r} is not a plain number"
    value, decimals = parsed
    price_decimals = call.result.get("price_decimals") if isinstance(call.result, dict) else None
    candidates = [leaf for leaf in leaves(call.result) if leaf.unit == claim.unit]
    if not candidates:
        return f"claim '{claim.text}' ({claim.value} {claim.unit}): no {claim.unit} field in {call.name}'s result"
    if any(_matches(value, decimals, claim.unit, leaf, price_decimals) for leaf in candidates):
        return None
    if claim.unit == "price" and isinstance(price_decimals, int) and any(leaf.value == value for leaf in candidates):
        # The exact mid (one digit more than the pair's decimals): say how to write it
        expected = _round(value, price_decimals)
        return (
            f"claim '{claim.text}' ({claim.value} price): write prices with exactly {price_decimals} decimals, "
            f"rounded half away from zero: {expected}"
        )
    return f"claim '{claim.text}' ({claim.value} {claim.unit}) matches no {claim.unit} field of {call.name}'s result"


@dataclass(frozen=True)
class TextNumber:
    value: Decimal
    decimals: int
    unit: str | None
    raw: str


def _text_unit(dollar: str | None, suffix: str | None) -> str | None:
    s = (suffix or "").strip().lower()
    if dollar or s == "usd":
        return "usd"
    if s in ("%", "percent"):
        return "pct"
    if s == "price":
        return "price"
    if s in ("pip", "pips"):
        return "pips"
    return None


def _direction(text_before: str) -> int:
    """+1 / -1 from the closest direction word within the window before a number, else 0. Only the
    number's own clause counts: the search stops at the previous number and at , ; : ( ) . !"""
    clause = _CLAUSE_BREAK.split(text_before)[-1]
    for word in reversed(_WORD.findall(clause)[-DIRECTION_WINDOW:]):
        w = word.lower()
        if w in NEGATIVE_WORDS:
            return -1
        if w in POSITIVE_WORDS:
            return 1
    return 0


def _mask(text: str, pattern: re.Pattern[str]) -> str:
    return pattern.sub(lambda m: " " * len(m.group(0)), text)


def text_numbers(answer: str, years: tuple[int, int] = DATA_YEARS) -> tuple[list[TextNumber], list[str], list[str]]:
    """(numbers, dates, failures) in an answer text."""
    failures: list[str] = []
    dates = [m.group(1) for m in _DATE.finditer(answer)]
    masked = answer
    for pattern in (_UUID, _DATE, _TIME, _PAIR, _TIMEFRAME, _MODEL_ID):
        masked = _mask(masked, pattern)
    numbers: list[TextNumber] = []
    for m in _NUMBER.finditer(masked):
        # part of a word (e.g. "x2") is not a number
        if m.start("num") > 0 and masked[m.start("num") - 1].isalpha():
            continue
        num = m.group("num")
        unit = _text_unit(m.group("dollar"), m.group("suffix"))
        parsed = _parse_value(num)
        if parsed is None:
            continue
        value, decimals = parsed
        sign_text = m.group("sign")
        if sign_text == "-" and m.start() > 0 and masked[m.start() - 1].isdigit():
            sign_text = None  # a range like 2016-2022, not a minus sign
        if unit is None and sign_text is None and decimals == 0 and "," not in num and years[0] <= value <= years[1]:
            continue  # a bare year
        written = -1 if sign_text in ("-", "\u2212") else 1 if sign_text == "+" else 0
        direction = _direction(masked[: m.start()])
        if written and direction and written != direction:
            failures.append(f"'{m.group(0).strip()}': its sign contradicts the direction word before it")
            continue
        sign = written or direction or 1
        numbers.append(TextNumber(value * sign, decimals, unit, m.group(0).strip()))
    return numbers, dates, failures


def verify(report_type: str, answer: str, claims: list[Claim], calls: list[CallResult]) -> Verification:
    by_id = {c.id: c for c in calls}
    failures: list[str] = []
    numbers, dates, text_failures = text_numbers(
        answer, ANY_YEARS if report_type in ("refusal", "not_in_data") else DATA_YEARS
    )
    failures.extend(text_failures)

    if report_type in ("refusal", "not_in_data"):
        if not answer.strip():
            failures.append(f"the {report_type} answer is empty")
        if claims:
            failures.append(f"a {report_type} answer must not contain claims")
        if numbers:
            failures.append(f"a {report_type} answer must not contain numbers: {', '.join(n.raw for n in numbers)}")
        return Verification(ok=not failures, failures=failures, claims_checked=0, numbers_checked=len(numbers))

    if report_type != "answer":
        failures.append(f"unknown report type {report_type}")
    if not any(c.ok for c in calls):
        failures.append("no successful tool call backs this answer")
    if not claims:
        failures.append("an answer must contain at least one claim")
    if not answer.strip():
        failures.append("the answer is empty")

    verified: list[Claim] = []
    for claim in claims:
        reason = check_claim(claim, by_id)
        if reason:
            failures.append(reason)
        else:
            verified.append(claim)

    claimed = []
    for c in verified:
        parsed = _parse_value(c.value)
        if parsed is not None:
            claimed.append((parsed[0], c.unit))
    for n in numbers:
        ok = any(v == n.value and (n.unit is None or n.unit == unit) for v, unit in claimed)
        if not ok:
            failures.append(f"number '{n.raw}' in the answer is not one of the verified claims (as {n.value})")

    haystack = json.dumps([{"args": c.args, "result": c.result} for c in calls if c.ok])
    for d in dates:
        if d not in haystack:
            failures.append(f"date {d} in the answer appears in no tool call")

    return Verification(ok=not failures, failures=failures, claims_checked=len(claims), numbers_checked=len(numbers))
