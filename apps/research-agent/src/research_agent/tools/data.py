"""Market data tools on the imported history (historical_candles_1h/_4h/_1d), from integer
bid/ask points; prices are mid = (bid + ask) / 2, the convention of ml-service's mid_ohlc.

get_market_stats formulas (n bars in the window, c = mid close, o = mid open, h/l = mean of
the bid and ask highs/lows, as stored per bar):
  return_pct                  (c[n-1] - o[0]) / o[0] x 100
  up/down/flat_bars_count     c > o / c < o / c = o, compared exactly in points
  high_price, low_price       highest h / lowest l (earliest bar on a tie), with its bar time
  avg_range_pips              mean(h - l) / pip
  avg_spread_pips             mean(ask close - bid close) / pip
  realized_vol_per_bar_pct    sample stdev of ln(c[t] / c[t-1]), t = 1..n-1, x 100 (null below 2 returns)
  realized_vol_annualized_pct per-bar value x sqrt(260), 1d only (null otherwise; step-3 convention)
  max_drawdown_pct            max over t of (peak - c[t]) / peak x 100, peak = max(o[0], c[0..t]); >= 0
"""

from __future__ import annotations

import math
import statistics
from decimal import Decimal
from typing import Any

import psycopg

from research_agent.domain import (
    PAIRS,
    TABLES,
    TIMEFRAMES,
    Coverage,
    ToolError,
    Window,
    check_pair,
    check_timeframe,
    coverage,
    iso_utc,
    window,
)

MAX_BARS = 50
SQRT_DAYS_PER_YEAR = math.sqrt(260)
ROUND = 6  # decimals kept for derived pct/pips values

Conn = psycopg.Connection[tuple[Any, ...]]


def _bars(conn: Conn, timeframe: str, pair: str, w: Window) -> list[tuple[Any, ...]]:
    table = TABLES[timeframe]  # from the whitelist, never from input
    return conn.execute(
        f"SELECT bucket, bid_open, bid_high, bid_low, bid_close, ask_open, ask_high, ask_low, ask_close "
        f"FROM {table} WHERE pair = %s AND bucket >= %s AND bucket <= %s ORDER BY bucket",
        (pair, w.start, w.last_bucket),
    ).fetchall()


def _price(mid2: int, cov: Coverage) -> float:
    """Twice the mid in points -> price (exact decimal, at most price_decimals + 1 digits)."""
    return float(Decimal(mid2) / 2 / (Decimal(10) ** cov.price_decimals))


def _r(x: float) -> float:
    return round(x, ROUND)


def list_available_data(conn: Conn) -> dict[str, Any]:
    pairs = []
    for pair in PAIRS:
        cov = coverage(conn, pair)
        h1 = conn.execute("SELECT count(*) FROM historical_candles_1h WHERE pair = %s", (pair,)).fetchone()
        if h1 is None or not h1[0]:
            raise RuntimeError(f"{pair}: no H1 bars")
        pairs.append(
            {
                "pair": pair,
                "first_bar_utc": iso_utc(cov.first_time),
                "last_bar_utc": iso_utc(cov.last_time),
                "first_date": cov.first_day.isoformat(),
                "last_date": cov.last_day.isoformat(),
                "price_decimals": cov.price_decimals,
                "pip_size_price": float(Decimal(cov.pip_size)),
                "h1_bars_count": int(h1[0]),
                "timeframes": list(TIMEFRAMES),
            }
        )
    return {
        "pairs": pairs,
        "source": "Dukascopy M1 bid/ask history; 1h bars in UTC, 4h and 1d bars close at 17:00 New York",
        "also": "the caller's completed backtest runs; ML walk-forward evaluation 2016-2022 (not live signals)",
    }


def get_bars(conn: Conn, pair: str, timeframe: str, from_day: str, to_day: str) -> dict[str, Any]:
    pair, timeframe = check_pair(pair), check_timeframe(timeframe)
    cov = coverage(conn, pair)
    w = window(cov, timeframe, from_day, to_day)
    n = conn.execute(
        f"SELECT count(*) FROM {TABLES[timeframe]} WHERE pair = %s AND bucket >= %s AND bucket <= %s",
        (pair, w.start, w.last_bucket),
    ).fetchone()
    count = int(n[0]) if n else 0
    if count > MAX_BARS:
        raise ToolError(
            "TOO_MANY_ROWS",
            f"{count} {timeframe} bars in that range; at most {MAX_BARS} are returned. "
            "Narrow the range, use a longer timeframe, or use get_market_stats.",
        )
    rows = _bars(conn, timeframe, pair, w)
    if not rows:
        raise ToolError("NO_BARS", f"no {timeframe} bars for {pair} from {w.from_day} to {w.to_day} (market closed?)")
    return {
        "pair": pair,
        "timeframe": timeframe,
        "from_date": w.from_day.isoformat(),
        "to_date": w.to_day.isoformat(),
        "price_decimals": cov.price_decimals,
        "columns": ["time_utc", "open_price", "high_price", "low_price", "close_price", "close_spread_pips"],
        "rows": [
            [
                iso_utc(r[0]),
                _price(r[1] + r[5], cov),
                _price(r[2] + r[6], cov),
                _price(r[3] + r[7], cov),
                _price(r[4] + r[8], cov),
                _r((r[8] - r[4]) / cov.points_per_pip),
            ]
            for r in rows
        ],
    }


def get_market_stats(conn: Conn, pair: str, timeframe: str, from_day: str, to_day: str) -> dict[str, Any]:
    pair, timeframe = check_pair(pair), check_timeframe(timeframe)
    cov = coverage(conn, pair)
    w = window(cov, timeframe, from_day, to_day)
    rows = _bars(conn, timeframe, pair, w)
    if not rows:
        raise ToolError("NO_BARS", f"no {timeframe} bars for {pair} from {w.from_day} to {w.to_day} (market closed?)")

    # Twice the mid, in integer points: exact
    o2 = [int(r[1] + r[5]) for r in rows]
    h2 = [int(r[2] + r[6]) for r in rows]
    l2 = [int(r[3] + r[7]) for r in rows]
    c2 = [int(r[4] + r[8]) for r in rows]
    n = len(rows)
    ppp = cov.points_per_pip

    hi = max(range(n), key=lambda i: (h2[i], -i))
    lo = min(range(n), key=lambda i: (l2[i], i))
    returns = [math.log(c2[i] / c2[i - 1]) for i in range(1, n)]
    vol = statistics.stdev(returns) * 100 if len(returns) >= 2 else None
    peak, dd = o2[0], 0.0
    for c in c2:
        peak = max(peak, c)
        dd = max(dd, (peak - c) / peak)

    return {
        "pair": pair,
        "timeframe": timeframe,
        "from_date": w.from_day.isoformat(),
        "to_date": w.to_day.isoformat(),
        "first_bar_utc": iso_utc(rows[0][0]),
        "last_bar_utc": iso_utc(rows[-1][0]),
        "price_decimals": cov.price_decimals,
        "bars_count": n,
        "first_open_price": _price(o2[0], cov),
        "last_close_price": _price(c2[-1], cov),
        "return_pct": _r((c2[-1] - o2[0]) / o2[0] * 100),
        "up_bars_count": sum(1 for a, b in zip(o2, c2, strict=True) if b > a),
        "down_bars_count": sum(1 for a, b in zip(o2, c2, strict=True) if b < a),
        "flat_bars_count": sum(1 for a, b in zip(o2, c2, strict=True) if b == a),
        "high_price": _price(h2[hi], cov),
        "high_time_utc": iso_utc(rows[hi][0]),
        "low_price": _price(l2[lo], cov),
        "low_time_utc": iso_utc(rows[lo][0]),
        "avg_range_pips": _r(sum(h - lo_ for h, lo_ in zip(h2, l2, strict=True)) / (2 * n * ppp)),
        "avg_spread_pips": _r(sum(int(r[8] - r[4]) for r in rows) / (n * ppp)),
        "realized_vol_per_bar_pct": None if vol is None else _r(vol),
        "realized_vol_annualized_pct": None if vol is None or timeframe != "1d" else _r(vol * SQRT_DAYS_PER_YEAR),
        "max_drawdown_pct": _r(dd * 100),
    }
