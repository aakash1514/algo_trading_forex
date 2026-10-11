"""H1 bars from the imported history, as integer points (no float prices)."""

from __future__ import annotations

import csv
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import numpy.typing as npt
import psycopg

I64 = npt.NDArray[np.int64]

PAIRS = ("EUR/USD", "GBP/USD", "USD/JPY", "XAU/USD")


@dataclass(frozen=True)
class Bars:
    """One pair's H1 bars, oldest first. Prices are integer points
    (price x 10^price_decimals); `time` is the bucket start in epoch seconds (UTC)."""

    pair: str
    pip_points: int  # points per pip (instruments.pip_size x 10^price_decimals)
    time: I64
    bid_open: I64
    bid_high: I64
    bid_low: I64
    bid_close: I64
    ask_open: I64
    ask_high: I64
    ask_low: I64
    ask_close: I64
    minutes: I64

    def __post_init__(self) -> None:
        n = len(self.time)
        if n == 0:
            raise ValueError(f"no bars for {self.pair}")
        for name in ("bid_open", "bid_high", "bid_low", "bid_close", "ask_open", "ask_high", "ask_low", "ask_close"):
            if len(getattr(self, name)) != n:
                raise ValueError(f"{name} has {len(getattr(self, name))} values, time has {n}")
        if len(self.minutes) != n:
            raise ValueError("minutes length differs")
        if np.any(np.diff(self.time) <= 0):
            raise ValueError("bars are not strictly increasing in time")
        if self.pip_points < 1:
            raise ValueError("pip_points must be positive")

    def __len__(self) -> int:
        return len(self.time)

    def slice(self, start: int, stop: int) -> Bars:
        cols = {k: getattr(self, k)[start:stop] for k in _COLUMNS}
        return Bars(pair=self.pair, pip_points=self.pip_points, **cols)


_COLUMNS = (
    "time",
    "bid_open",
    "bid_high",
    "bid_low",
    "bid_close",
    "ask_open",
    "ask_high",
    "ask_low",
    "ask_close",
    "minutes",
)


def pip_points(conn: psycopg.Connection[tuple[object, ...]], pair: str) -> int:
    row = conn.execute(
        "SELECT round(i.pip_size * 10::numeric ^ s.price_decimals)::int, "
        "i.pip_size * 10::numeric ^ s.price_decimals = round(i.pip_size * 10::numeric ^ s.price_decimals) "
        "FROM instruments i JOIN historical_price_scale s ON s.pair = i.pair WHERE i.pair = %s",
        (pair,),
    ).fetchone()
    if row is None:
        raise ValueError(f"{pair}: no instruments / historical_price_scale row")
    points, whole = row
    if not whole:
        raise ValueError(f"{pair}: pip size is not a whole number of points")
    return int(str(points))


def read_bars(conn: psycopg.Connection[tuple[object, ...]], pair: str, start: datetime, end: datetime) -> Bars:
    """H1 bars with start <= bucket < end (historical_candles_1h)."""
    if start.tzinfo is None or end.tzinfo is None:
        raise ValueError("start and end must be timezone-aware")
    rows = conn.execute(
        "SELECT extract(epoch FROM bucket)::bigint, bid_open, bid_high, bid_low, bid_close, "
        "ask_open, ask_high, ask_low, ask_close, minutes "
        "FROM historical_candles_1h WHERE pair = %s AND bucket >= %s AND bucket < %s ORDER BY bucket",
        (pair, start, end),
    ).fetchall()
    if not rows:
        raise ValueError(f"no H1 bars for {pair} in [{start.isoformat()}, {end.isoformat()})")
    data = np.array(rows, dtype=np.int64)
    return Bars(pair=pair, pip_points=pip_points(conn, pair), **{k: data[:, i].copy() for i, k in enumerate(_COLUMNS)})


def read_csv(path: Path, pair: str, pip_points: int) -> Bars:
    """A fixture exported with tests/fixtures/README.md's query (bucket in ms)."""
    with path.open(newline="", encoding="utf-8") as f:
        reader = csv.reader(f)
        header = next(reader)
        expected = ["bucket_ms", *_COLUMNS[1:]]
        if header != expected:
            raise ValueError(f"{path.name}: header {header} != {expected}")
        rows = [[int(v) for v in r] for r in reader if r]
    if not rows:
        raise ValueError(f"{path.name}: no rows")
    data = np.array(rows, dtype=np.int64)
    if np.any(data[:, 0] % 1000 != 0):
        raise ValueError("bucket_ms is not whole seconds")
    data[:, 0] //= 1000
    return Bars(pair=pair, pip_points=pip_points, **{k: data[:, i].copy() for i, k in enumerate(_COLUMNS)})


def utc(epoch_seconds: int) -> datetime:
    return datetime.fromtimestamp(int(epoch_seconds), tz=UTC)
