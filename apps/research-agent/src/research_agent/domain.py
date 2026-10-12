"""Shared rules for every tool: the pair and timeframe whitelists, the inclusive date window
(the step-3 backtest rule), tool errors, and the unit suffixes the verifier relies on.

Every numeric field a tool returns is named with its unit as a suffix (_price, _pips, _pct,
_usd, _count, ...); the verifier matches a claim's unit against that suffix."""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any, Literal

import psycopg

PAIRS = ("EUR/USD", "GBP/USD", "USD/JPY", "XAU/USD")
TIMEFRAMES = ("1h", "4h", "1d")
Pair = Literal["EUR/USD", "GBP/USD", "USD/JPY", "XAU/USD"]
Timeframe = Literal["1h", "4h", "1d"]

# The continuous aggregates per timeframe: 1h in UTC buckets, 4h and 1d New York 17:00 aligned
TABLES: dict[str, str] = {"1h": "historical_candles_1h", "4h": "historical_candles_4h", "1d": "historical_candles_1d"}
BAR: dict[str, timedelta] = {"1h": timedelta(hours=1), "4h": timedelta(hours=4), "1d": timedelta(days=1)}

# Unit suffixes (the text after the last "_"); a field without one carries no unit
UNITS = ("price", "pips", "pct", "usd", "count", "ratio", "p", "utc", "date")

DISCLAIMER = (
    "Historical analysis of ForexEdge's own data only; not financial advice, and nothing here is a "
    "signal to buy or sell."
)

_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_PAIR_SHAPE = re.compile(r"^[A-Z]{3}/[A-Z]{3}$")


class ToolError(Exception):
    """A refusal the agent can act on. code: OUT_OF_DATA, INVALID_ARGUMENT, TOO_MANY_ROWS,
    NO_BARS, NOT_FOUND, UPSTREAM_ERROR."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message

    def payload(self) -> dict[str, Any]:
        return {"error": {"code": self.code, "message": self.message}}


def unit_of(field: str) -> str | None:
    for unit in UNITS:
        if field.endswith("_" + unit):
            return unit
    return None


def check_pair(pair: str) -> str:
    if pair in PAIRS:
        return pair
    if _PAIR_SHAPE.match(pair):
        raise ToolError("OUT_OF_DATA", f"{pair} is not in ForexEdge data; pairs: {', '.join(PAIRS)}")
    raise ToolError("INVALID_ARGUMENT", f"pair must be one of {', '.join(PAIRS)} (slash format)")


def check_timeframe(timeframe: str) -> str:
    if timeframe not in TIMEFRAMES:
        raise ToolError("INVALID_ARGUMENT", f"timeframe must be one of {', '.join(TIMEFRAMES)}")
    return timeframe


def parse_day(day: str, name: str) -> date:
    if not _DAY.match(day):
        raise ToolError("INVALID_ARGUMENT", f"{name} must be a calendar date YYYY-MM-DD")
    try:
        return date.fromisoformat(day)
    except ValueError as err:
        raise ToolError("INVALID_ARGUMENT", f"{name} {day} is not a calendar date") from err


@dataclass(frozen=True)
class Coverage:
    pair: str
    price_decimals: int
    pip_size: str  # exact decimal text from instruments
    points_per_pip: int
    first_time: datetime
    last_time: datetime
    first_day: date
    last_day: date


def coverage(conn: psycopg.Connection[tuple[Any, ...]], pair: str) -> Coverage:
    row = conn.execute(
        "SELECT c.price_decimals, i.pip_size, c.first_time, c.last_time "
        "FROM historical_coverage c JOIN instruments i ON i.pair = c.pair WHERE c.pair = %s",
        (pair,),
    ).fetchone()
    if row is None:
        raise ToolError("OUT_OF_DATA", f"no history for {pair}")
    decimals, pip_size, first, last = int(row[0]), row[1], row[2], row[3]
    points = pip_size * (10**decimals)
    if points != int(points) or int(points) <= 0:
        raise RuntimeError(f"{pair}: pip size {pip_size} is not a whole number of points at {decimals} decimals")
    return Coverage(
        pair=pair,
        price_decimals=decimals,
        pip_size=format(pip_size.normalize(), "f"),
        points_per_pip=int(points),
        first_time=first,
        last_time=last,
        first_day=first.astimezone(UTC).date(),
        last_day=last.astimezone(UTC).date(),
    )


@dataclass(frozen=True)
class Window:
    """[from 00:00 UTC, the day after to 00:00 UTC), whole bars only: bucket >= start and
    bucket + bar <= end (the step-3 rule in ws-gateway backtest-window.ts)."""

    from_day: date
    to_day: date
    start: datetime
    last_bucket: datetime


def window(cov: Coverage, timeframe: str, from_day: str, to_day: str) -> Window:
    d0, d1 = parse_day(from_day, "from"), parse_day(to_day, "to")
    if d0 > d1:
        raise ToolError("INVALID_ARGUMENT", "from is after to")
    if d0 < cov.first_day or d1 > cov.last_day:
        raise ToolError(
            "OUT_OF_DATA",
            f"{cov.pair} history covers {cov.first_day} to {cov.last_day} only; the range {d0} to {d1} is outside it",
        )
    start = datetime(d0.year, d0.month, d0.day, tzinfo=UTC)
    end = datetime(d1.year, d1.month, d1.day, tzinfo=UTC) + timedelta(days=1)
    return Window(from_day=d0, to_day=d1, start=start, last_bucket=end - BAR[timeframe])


def iso_utc(t: datetime) -> str:
    return t.astimezone(UTC).isoformat().replace("+00:00", "Z")
