"""Backtest tools on the real research demo runs (tools/ops/research-demo-data.ts), on the dev
database through the read-only research login.

Expected values come from two independent places: a direct SQL read of backtest_runs, and the
backtest:verify reports, where each run was reproduced from raw M1 bars by SQL and matched
(docs/validation/research-demo-backtests.md, research-demo-2-backtests.md).

RUN_DB_TESTS=true npx nx test research-agent
"""

from __future__ import annotations

import json
import os
import re
import uuid
from collections.abc import Iterator
from decimal import Decimal
from typing import Any

import psycopg
import pytest

from research_agent.config import REPO_ROOT
from research_agent.db import connect
from research_agent.domain import ToolError
from research_agent.tools import backtests
from research_agent.tools.backtests import get_backtest_run, list_backtest_runs

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(os.environ.get("RUN_DB_TESTS") != "true", reason="needs RUN_DB_TESTS=true and the dev database"),
]

Conn = psycopg.Connection[tuple[Any, ...]]
ROW = re.compile(
    r"^\| (?P<pair>[A-Z]{3}/[A-Z]{3}) \| `(?P<run>[0-9a-f-]{36})` \| \d+ \| (?P<trades>\d+) / \d+ \| "
    r"(?P<usd>-?[\d.]+) / (?P<usd_sql>-?[\d.]+) \| (?P<equity>-?[\d.]+) / [-\d.]+ \| (?P<dd>-?[\d.]+) / [-\d.]+ \| "
    r"(?P<sharpe>-?[\d.]+|—) / [^|]+ \| (?P<win>[\d.]+|—) / [^|]+ \| (?P<pf>[\d.]+|—) / [^|]+ \| \*\*match\*\*"
)


def verified_runs(report: str) -> list[dict[str, str]]:
    text = (REPO_ROOT / "docs" / "validation" / report).read_text(encoding="utf-8")
    rows = [m.groupdict() for line in text.splitlines() if (m := ROW.match(line))]
    assert rows, f"no verified runs in {report}"
    return rows


DEMO = verified_runs("research-demo-backtests.md")
DEMO_2 = verified_runs("research-demo-2-backtests.md")


@pytest.fixture(scope="module")
def conn() -> Iterator[Conn]:
    with connect() as c:
        yield c


def owner(conn: Conn, run_id: str) -> str:
    row = conn.execute("SELECT user_id FROM backtest_runs WHERE id = %s", (run_id,)).fetchone()
    assert row is not None, f"run {run_id} from the verify report is missing: re-create the demo data (README)"
    return str(row[0])


@pytest.fixture(scope="module")
def demo_user(conn: Conn) -> str:
    users = {owner(conn, r["run"]) for r in DEMO}
    assert len(users) == 1
    return users.pop()


@pytest.fixture(scope="module")
def demo_2_user(conn: Conn, demo_user: str) -> str:
    users = {owner(conn, r["run"]) for r in DEMO_2}
    assert len(users) == 1 and demo_user not in users
    return users.pop()


def test_the_demo_reports_hold_the_expected_runs() -> None:
    assert [r["pair"] for r in DEMO] == ["EUR/USD", "XAU/USD", "USD/JPY"]
    assert [r["pair"] for r in DEMO_2] == ["EUR/USD"]
    for r in DEMO + DEMO_2:
        assert r["usd"] == r["usd_sql"]  # the report's own backtester/SQL agreement


@pytest.mark.parametrize("which", ["demo", "demo_2"])
def test_each_user_lists_exactly_their_own_runs(conn: Conn, demo_user: str, demo_2_user: str, which: str) -> None:
    user, verified = (demo_user, DEMO) if which == "demo" else (demo_2_user, DEMO_2)
    tool = list_backtest_runs(conn, user)
    sql = conn.execute(
        "SELECT id FROM backtest_runs WHERE user_id = %s AND status = 'COMPLETED' ORDER BY completed_at DESC, id",
        (user,),
    ).fetchall()
    assert len(sql) > 0
    assert [r["run_id"] for r in tool["runs"]] == [str(s[0]) for s in sql]
    assert tool["runs_count"] == len(sql)
    assert {r["run_id"] for r in tool["runs"]} == {v["run"] for v in verified}


@pytest.mark.parametrize("verified", DEMO + DEMO_2, ids=lambda v: v["run"][:8])
def test_run_metrics_equal_sql_and_the_verify_report(
    conn: Conn, demo_user: str, demo_2_user: str, verified: dict[str, str]
) -> None:
    user = demo_user if verified in DEMO else demo_2_user
    tool = get_backtest_run(conn, user, verified["run"])
    row = conn.execute(
        "SELECT instrument, total_trades, win_rate, profit_factor, sharpe_ratio, max_drawdown_pct, total_pnl, "
        "total_pnl_usd, initial_capital, lots, parameters FROM backtest_runs WHERE id = %s",
        (verified["run"],),
    ).fetchone()
    assert row is not None
    instrument, trades, win, pf, sharpe, dd, pips, usd, capital, lots, params = row
    # As stored
    assert tool["pair"] == instrument.replace("_", "/") == verified["pair"]
    assert tool["total_trades_count"] == trades
    assert tool["win_rate_pct"] == float(win)
    assert tool["profit_factor_ratio"] == float(pf)
    assert tool["sharpe_ratio"] == float(sharpe)
    assert tool["max_drawdown_pct"] == float(dd)
    assert tool["total_pnl_pips"] == float(pips)
    assert tool["total_pnl_usd"] == float(usd)
    assert tool["initial_capital_usd"] == float(capital) and tool["size_lots"] == float(lots)
    assert tool["parameters"] == {f"{k}_param": v for k, v in params.items()}
    # As verified against the SQL reproduction from M1 bars
    assert tool["total_trades_count"] == int(verified["trades"])
    assert Decimal(str(tool["total_pnl_usd"])) == Decimal(verified["usd"])
    assert Decimal(str(tool["final_equity_usd"])) == Decimal(verified["equity"])
    assert Decimal(str(tool["max_drawdown_pct"])) == Decimal(verified["dd"])
    assert Decimal(str(tool["sharpe_ratio"])) == Decimal(verified["sharpe"])
    assert Decimal(str(tool["win_rate_pct"])) == Decimal(verified["win"])
    assert Decimal(str(tool["profit_factor_ratio"])) == Decimal(verified["pf"])
    assert tool["max_drawdown_pct"] >= 0  # stored as a positive fall
    assert tool["trades_available"] is False


def test_no_object_storage_key_is_ever_returned(conn: Conn, demo_user: str) -> None:
    for v in DEMO:
        out = json.dumps(get_backtest_run(conn, demo_user, v["run"])) + json.dumps(list_backtest_runs(conn, demo_user))
        assert "minio_object_key" not in out
        assert f"{v['run']}/results.json" not in out
        assert "error_message" not in out


def test_users_cannot_see_each_others_runs(conn: Conn, demo_user: str, demo_2_user: str) -> None:
    listed = {r["run_id"] for r in list_backtest_runs(conn, demo_user)["runs"]}
    for v in DEMO_2:
        assert v["run"] not in listed
        with pytest.raises(ToolError) as err:
            get_backtest_run(conn, demo_user, v["run"])
        assert err.value.code == "NOT_FOUND"
    listed_2 = {r["run_id"] for r in list_backtest_runs(conn, demo_2_user)["runs"]}
    for v in DEMO:
        assert v["run"] not in listed_2
        with pytest.raises(ToolError) as err:
            get_backtest_run(conn, demo_2_user, v["run"])
        assert err.value.code == "NOT_FOUND"


def test_a_user_without_runs_gets_an_explicit_empty_result(conn: Conn) -> None:
    nobody = str(uuid.uuid4())
    assert conn.execute("SELECT count(*) FROM backtest_runs WHERE user_id = %s", (nobody,)).fetchone() == (0,)
    assert list_backtest_runs(conn, nobody) == {
        "runs": [],
        "runs_count": 0,
        "note": "no completed backtest runs for this user match the filters",
    }


def test_filters(conn: Conn, demo_user: str) -> None:
    usd_jpy = list_backtest_runs(conn, demo_user, pair="USD/JPY")["runs"]
    assert [r["pair"] for r in usd_jpy] == ["USD/JPY"]
    assert list_backtest_runs(conn, demo_user, pair="GBP/USD")["runs"] == []
    assert list_backtest_runs(conn, demo_user, strategy="london_breakout")["runs"] == []
    assert len(list_backtest_runs(conn, demo_user, strategy="ma_crossover", timeframe="1h")["runs"]) == 3
    assert len(list_backtest_runs(conn, demo_user, limit=1)["runs"]) == 1


@pytest.mark.parametrize(
    "kwargs",
    [{"pair": "EUR_USD"}, {"strategy": "rsi"}, {"timeframe": "1w"}, {"limit": 0}, {"limit": 21}],
)
def test_bad_filters_are_refused(conn: Conn, demo_user: str, kwargs: dict[str, Any]) -> None:
    with pytest.raises(ToolError) as err:
        list_backtest_runs(conn, demo_user, **kwargs)
    assert err.value.code == "INVALID_ARGUMENT"


@pytest.mark.parametrize("user_id", ["", "  ", "not-a-uuid"])
def test_a_missing_user_id_never_widens_the_query(conn: Conn, user_id: str) -> None:
    with pytest.raises(RuntimeError):
        list_backtest_runs(conn, user_id)
    with pytest.raises(RuntimeError):
        get_backtest_run(conn, user_id, DEMO[0]["run"])


def test_a_bad_run_id_is_invalid(conn: Conn, demo_user: str) -> None:
    with pytest.raises(ToolError) as err:
        get_backtest_run(conn, demo_user, "29f80e07")
    assert err.value.code == "INVALID_ARGUMENT"


def test_only_completed_runs_are_queried() -> None:
    # There is no non-COMPLETED run in the database (only the 4 verified demo runs), so the
    # exclusion is covered by the WHERE clause only; this pins it in both queries.
    import inspect

    src = inspect.getsource(backtests)
    assert src.count("status = 'COMPLETED'") == 2
