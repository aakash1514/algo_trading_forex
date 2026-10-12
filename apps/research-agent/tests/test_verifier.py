"""The verifier on recorded real tool results (tests/fixtures/tools, scripts/record_tool_fixtures.py).

The answers and claims are written here; every number in them is taken from those results, then
altered, dropped, mis-signed or mis-united to show the check fails."""

from __future__ import annotations

import json
from typing import Any

import pytest

from research_agent.config import SERVICE_ROOT
from research_agent.report import Claim
from research_agent.verifier import CallResult, leaves, text_numbers, verify

FIXTURES = SERVICE_ROOT / "tests" / "fixtures" / "tools"


def call(name: str) -> CallResult:
    r = json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))
    return CallResult(id=r["id"], name=r["name"], args=r["args"], result=r["result"])


STATS = call("stats-eurusd-2022-1d")  # return_pct -5.860216, max_drawdown_pct 16.243622, bars 260 ...
GOLD = call("stats-xauusd-2020-1d")
BARS = call("bars-usdjpy-2022-03-1d")  # rows include half-point mids, e.g. low 115.2635
RUN = call("backtest-demo-eurusd-2022")  # total_pnl_usd -272.2, win_rate_pct 31.52, sharpe -0.2145 ...
ML = call("ml-evaluation-eurusd")
ERROR = call("error-audusd")
ALL = [STATS, GOLD, BARS, RUN, ML, ERROR]


def c(value: str, unit: str, ref: CallResult, text: str = "x") -> Claim:
    return Claim(text=text, value=value, unit=unit, tool_call_id=ref.id)  # type: ignore[arg-type]


def ok(answer: str, claims: list[Claim], calls: list[CallResult] | None = None, kind: str = "answer") -> list[str]:
    return verify(kind, answer, claims, ALL if calls is None else calls).failures


def test_the_fixtures_are_the_real_results() -> None:
    assert STATS.result["return_pct"] == -5.860216 and STATS.result["bars_count"] == 260
    assert RUN.result["total_pnl_usd"] == -272.2 and RUN.result["max_drawdown_pct"] == 11.1369
    assert ML.result["below_break_even"] is True
    assert ERROR.result["error"]["code"] == "OUT_OF_DATA"
    assert len(leaves(STATS.result)) > 10 and len(leaves(BARS.result)) == 4 * 5


# --- correct numbers pass ---------------------------------------------------------------


def test_a_correct_answer_passes() -> None:
    answer = (
        "From 2022-01-01 to 2022-12-30 EUR/USD fell 5.86% on daily bars (260 bars, 130 up and 130 down), "
        "from 1.13733 to 1.07068, with a maximum drawdown of 16.24%."
    )
    claims = [
        c("-5.86", "pct", STATS),
        c("260", "count", STATS),
        c("130", "count", STATS),
        c("1.13733", "price", STATS),
        c("1.07068", "price", STATS),
        c("16.24", "pct", STATS),
    ]
    assert ok(answer, claims) == []


def test_backtest_and_ml_numbers_pass() -> None:
    answer = (
        "The run lost $272.20, with a win rate of 31.52% and a Sharpe ratio of -0.2145; the LSTM's pooled "
        "accuracy was 51.76%, below the 53.24% break-even."
    )
    claims = [
        c("-272.20", "usd", RUN),
        c("31.52", "pct", RUN),
        c("-0.2145", "ratio", RUN),
        c("51.76", "pct", ML),
        c("53.24", "pct", ML),
    ]
    assert ok(answer, claims) == []


def test_prices_round_half_away_from_zero_to_the_pairs_decimals() -> None:
    # The USD/JPY low on 2022-03-07 is a half-point mid: 115.2635 -> 115.264 at 3 decimals
    assert ok("The low was 115.264.", [c("115.264", "price", BARS)]) == []
    assert ok("The low was 115.263.", [c("115.263", "price", BARS)]) != []  # rounded the wrong way
    assert ok("The low was 115.26.", [c("115.26", "price", BARS)]) != []  # fewer than price_decimals
    assert ok("The low was 115.2635.", [c("115.2635", "price", BARS)]) != []  # more than price_decimals


def test_rounded_values_keep_three_significant_digits() -> None:
    assert ok("Drawdown 16.2%.", [c("16.2", "pct", STATS)]) == []
    assert ok("Drawdown 16%.", [c("16", "pct", STATS)]) != []  # 2 significant digits
    assert ok("Sharpe -0.215.", [c("-0.215", "ratio", RUN)]) == []
    assert ok("Sharpe -0.21.", [c("-0.21", "ratio", RUN)]) != []


# --- altered, missing, wrong unit, wrong sign --------------------------------------------


def test_an_altered_number_fails() -> None:
    f = ok("EUR/USD fell 5.87% in 2022.", [c("-5.87", "pct", STATS)])
    assert any("matches no pct field" in x for x in f)
    assert ok("The run lost $272.21.", [c("-272.21", "usd", RUN)]) != []  # USD is exact
    assert ok("261 bars.", [c("261", "count", STATS)]) != []


def test_a_number_in_the_text_without_a_claim_fails() -> None:
    f = ok("EUR/USD fell 5.86% with a 16.24% drawdown.", [c("-5.86", "pct", STATS)])
    assert any("'16.24%'" in x for x in f)


def test_a_claim_from_the_wrong_call_or_an_unknown_call_fails() -> None:
    assert ok("Return -5.86%.", [c("-5.86", "pct", GOLD)]) != []
    bad = Claim(text="x", value="-5.86", unit="pct", tool_call_id="call_nope")
    assert any("unknown tool call" in x for x in ok("Return -5.86%.", [bad]))


def test_a_claim_on_a_failed_call_fails() -> None:
    assert any("returned an error" in x for x in ok("4 bars.", [c("4", "count", ERROR)]))


def test_wrong_unit_fails() -> None:
    # 16.24 is a pct field, not pips; and a fraction is never turned into a percent
    assert ok("Drawdown 16.24 pips.", [c("16.24", "pips", STATS)]) != []
    assert ok("Drawdown 16.24 pips.", [c("16.24", "pct", STATS)]) != []  # text unit pips vs claim pct
    assert ok("Return -0.0586.", [c("-0.0586", "ratio", STATS)]) != []


def test_a_negative_return_phrased_rose_fails() -> None:
    f = ok("EUR/USD rose 5.86% in 2022.", [c("-5.86", "pct", STATS)])
    assert any("'5.86%'" in x for x in f)


def test_a_positive_return_phrased_fell_fails() -> None:
    gold = GOLD.result["return_pct"]
    assert gold > 0
    value = f"{gold:.2f}"
    assert ok(f"Gold rose {value}% in 2020.", [c(value, "pct", GOLD)]) == []
    f = ok(f"Gold fell {value}% in 2020.", [c(value, "pct", GOLD)])
    assert any(f"'{value}%'" in x for x in f)


def test_a_signed_claim_never_matches_its_absolute_value() -> None:
    assert ok("Return 5.86%.", [c("5.86", "pct", STATS)]) != []  # the field is -5.860216
    assert ok("Return -5.86%.", [c("-5.86", "pct", STATS)]) == []


def test_a_written_sign_that_contradicts_the_direction_word_fails() -> None:
    assert any("contradicts" in x for x in ok("EUR/USD rose -5.86%.", [c("-5.86", "pct", STATS)]))
    assert ok("EUR/USD fell -5.86%.", [c("-5.86", "pct", STATS)]) == []


def test_dates_must_come_from_a_tool_call() -> None:
    assert ok("On 2022-09-27 the low was 0.95360.", [c("0.95360", "price", STATS)]) == []
    f = ok("On 2022-09-28 the low was 0.95360.", [c("0.95360", "price", STATS)])
    assert any("2022-09-28" in x for x in f)


def test_years_pairs_timeframes_and_ranges_are_not_numbers() -> None:
    numbers, _, failures = text_numbers("EUR/USD on 1h and 1d bars, H1, 2016-2022 and 2010; lstm-h32-w32.")
    assert numbers == [] and failures == []


# --- empty input fails -------------------------------------------------------------------


def test_empty_input_fails() -> None:
    assert ok("", [], []) != []
    assert any("no successful tool call" in x for x in ok("EUR/USD fell 5.86%.", [c("-5.86", "pct", STATS)], []))
    assert any("at least one claim" in x for x in ok("EUR/USD fell in 2022.", []))
    assert any("no successful tool call" in x for x in ok("4 bars.", [c("4", "count", ERROR)], [ERROR]))


@pytest.mark.parametrize("kind", ["refusal", "not_in_data"])
def test_refusals_carry_no_numbers_or_claims(kind: str) -> None:
    assert ok("ForexEdge doesn't give buy or sell advice.", [], [], kind) == []
    assert ok("AUD/USD is not in ForexEdge data (2010-2022 only).", [], [ERROR], kind) == []
    assert ok("EUR/USD fell 5.86% though.", [], [STATS], kind) != []
    assert ok("No.", [c("-5.86", "pct", STATS)], [STATS], kind) != []


def test_every_failure_is_reported_not_just_the_first() -> None:
    f = ok("EUR/USD rose 5.86% to 1.07069 over 261 bars.", [c("1.07069", "price", STATS), c("261", "count", STATS)])
    assert len(f) >= 4


def leaf_paths(result: Any) -> set[str]:
    return {leaf.path for leaf in leaves(result)}


def test_columnar_rows_take_their_units_from_the_columns() -> None:
    paths = leaf_paths(BARS.result)
    assert "rows[0].low_price" in paths and "rows[3].close_spread_pips" in paths
    assert not any("time_utc" in p for p in paths)


def test_a_year_outside_the_data_is_allowed_only_when_naming_what_is_missing() -> None:
    assert ok("EUR/USD in 2023 is outside ForexEdge data.", [], [], "not_in_data") == []
    assert ok("EUR/USD in 2023 is outside ForexEdge data.", [], [], "refusal") == []
    # In an answer, 2023 is not a bare year: it must be a claimed value
    f = ok("EUR/USD fell 5.86% before 2023.", [c("-5.86", "pct", STATS)])
    assert any("'2023'" in x for x in f)


def test_an_unrounded_mid_price_gets_the_rounding_rule_as_feedback() -> None:
    # The exact half-point mid 115.2635 written in full: rejected, with the rule and the rounded value
    f = ok("The low was 115.2635.", [c("115.2635", "price", BARS)])
    assert any("exactly 3 decimals, rounded half away from zero: 115.264" in x for x in f)


@pytest.mark.parametrize("kind", ["refusal", "not_in_data"])
def test_an_empty_refusal_or_not_in_data_answer_fails(kind: str) -> None:
    assert any("is empty" in x for x in ok("  ", [], [], kind))


@pytest.mark.parametrize("kind", ["refusal", "not_in_data"])
@pytest.mark.parametrize(
    "text", ["2050 pips is not in the data.", "2019% is not in the data.", "$2020 is not available.", "The 2050 price."]
)
def test_a_year_followed_or_preceded_by_a_unit_is_a_number(kind: str, text: str) -> None:
    assert any("must not contain numbers" in x for x in ok(text, [], [], kind))


@pytest.mark.parametrize("kind", ["refusal", "not_in_data"])
def test_a_bare_year_names_what_is_missing(kind: str) -> None:
    assert ok("2023 is not in the data.", [], [], kind) == []
