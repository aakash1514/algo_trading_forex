"""ML tools against recorded real ml-service responses (tests/fixtures/ml, scripts/record_ml_fixtures.py),
cross-checked with ml-service's own artifacts: models/evaluation.json, models/manifest.json and
the offline test predictions (models/*-test.npz).

RUN_LIVE_ML=true also runs them against a running ml-service (npx nx serve ml-service).
"""

from __future__ import annotations

import array
import ast
import json
import os
import zipfile
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import pytest

from research_agent.config import REPO_ROOT, SERVICE_ROOT
from research_agent.domain import PAIRS, ToolError
from research_agent.tools.ml import (
    CONCLUSION_BELOW,
    MlClient,
    get_ml_evaluation,
    get_ml_predictions,
    ml_base_url,
)
from tests.tokens import token

FIXTURES = SERVICE_ROOT / "tests" / "fixtures" / "ml"
ML_MODELS = REPO_ROOT / "apps" / "ml-service" / "models"
ARTIFACT = json.loads((ML_MODELS / "evaluation.json").read_text(encoding="utf-8"))
MANIFEST = json.loads((ML_MODELS / "manifest.json").read_text(encoding="utf-8"))
MONTHS = {"EUR/USD": (2022, 3), "GBP/USD": (2019, 6), "USD/JPY": (2020, 3), "XAU/USD": (2017, 10)}
TOKEN = token()


def load_npz(path: Path) -> dict[str, list[int]]:
    """The integer arrays of an .npz (zip of .npy files, format 1.0/2.0), with the standard library
    only: research-agent doesn't depend on numpy."""
    out: dict[str, list[int]] = {}
    with zipfile.ZipFile(path) as zf:
        for name in zf.namelist():
            raw = zf.read(name)
            assert raw[:6] == bytes([0x93]) + b"NUMPY"
            size_len = 2 if raw[6] == 1 else 4
            header_len = int.from_bytes(raw[8 : 8 + size_len], "little")
            start = 8 + size_len
            header = ast.literal_eval(raw[start : start + header_len].decode("latin1"))
            assert header["fortran_order"] is False and len(header["shape"]) == 1
            code = {"<i8": "q", "|i1": "b"}.get(header["descr"])
            if code is None:
                continue  # float arrays are not needed here
            out[name.removesuffix(".npy")] = list(array.array(code, raw[start + header_len :]))
            assert len(out[name.removesuffix(".npy")]) == header["shape"][0]
    return out


def recorded(request: httpx.Request) -> httpx.Response:
    """Serves the recorded responses, only for the request shapes ml-service accepts, and only
    with the caller's token forwarded."""
    assert request.headers["authorization"] == f"Bearer {TOKEN}"
    path = request.url.path.removeprefix("/api/ml")
    if path == "/evaluation" and not request.url.params:
        return httpx.Response(200, json=json.loads((FIXTURES / "evaluation.json").read_text(encoding="utf-8")))
    if path.startswith("/predictions/"):
        p = request.url.params
        assert p["timeframe"] == "1h"
        name = f"predictions-{path.split('/')[-1]}-{p['from'][:7]}.json"
        if (FIXTURES / name).is_file():
            body = json.loads((FIXTURES / name).read_text(encoding="utf-8"))
            assert (body["from"], body["to"]) == (p["from"], p["to"])
            return httpx.Response(200, json=body)
    raise AssertionError(f"unexpected request {request.url}")


def client(handler: Callable[[httpx.Request], httpx.Response] = recorded) -> MlClient:
    http = httpx.Client(base_url="http://ml.test/api/ml", transport=httpx.MockTransport(handler))
    return MlClient(http=http, token=TOKEN)


def artifact_rows(pair: str) -> list[dict[str, Any]]:
    rows = [r for r in ARTIFACT["significance"] if r["pair"] == pair]
    assert len(rows) == 4
    return rows


def test_the_recorded_evaluation_is_ml_services_artifact() -> None:
    rec = json.loads((FIXTURES / "evaluation.json").read_text(encoding="utf-8"))
    assert rec["pooled"] == ARTIFACT["significance"] and len(rec["pooled"]) == 16
    assert rec["breakEven"] == ARTIFACT["break_even"] and len(rec["breakEven"]) == 4
    assert rec["disclaimer"] == "historical walk-forward test, not live signals"


@pytest.mark.parametrize("pair", PAIRS)
def test_evaluation_equals_ml_services_artifact(pair: str) -> None:
    out = get_ml_evaluation(client(), pair)
    rows = artifact_rows(pair)
    be = next(b for b in ARTIFACT["break_even"] if b["pair"] == pair)
    assert out["samples_count"] == rows[0]["n"]
    assert out["lstm_accuracy_pct"] == rows[0]["lstm_accuracy"] * 100
    assert [out["lstm_ci95_low_pct"], out["lstm_ci95_high_pct"]] == [x * 100 for x in rows[0]["lstm_ci95"]]
    by_name = {b["baseline"]: b for b in out["baselines"]}
    assert sorted(by_name) == sorted(r["baseline"] for r in rows)
    for r in rows:
        b = by_name[r["baseline"]]
        assert b["baseline_accuracy_pct"] == r["baseline_accuracy"] * 100
        assert (b["raw_p"], b["holm_p"]) == (r["p_raw"], r["p_holm"])
        assert (b["lstm_beats_baseline"], b["lstm_significantly_worse"]) == (r["beats"], r["significantly_worse"])
    assert out["break_even_accuracy_pct"] == be["break_even_accuracy"] * 100
    assert (out["mean_spread_pips"], out["mean_move_pips"]) == (be["mean_spread_pips"], be["mean_move_pips"])
    # Derived from ml-service's numbers: below the spread break-even for every pair (step 4)
    assert out["below_break_even"] is (rows[0]["lstm_accuracy"] < be["break_even_accuracy"]) is True
    assert out["conclusion"] == CONCLUSION_BELOW
    assert out["disclaimer"] == "historical walk-forward test, not live signals"


def test_the_lstm_beats_9_of_16_comparisons_as_in_step_4() -> None:
    beaten = {p: get_ml_evaluation(client(), p)["baselines_beaten_count"] for p in PAIRS}
    assert beaten == {p: sum(r["beats"] for r in artifact_rows(p)) for p in PAIRS}
    assert sum(beaten.values()) == 9


@pytest.mark.parametrize("pair", PAIRS)
@pytest.mark.parametrize("year", [2016, 2019, 2022])
def test_year_metrics_equal_the_manifest(pair: str, year: int) -> None:
    out = get_ml_predictions(client(), pair, year)
    entry = next(m for m in MANIFEST["models"] if m["pair"] == pair and m["test_year"] == year)
    assert len(out["models"]) == 5
    for m in out["models"]:
        test = entry["test"][m["model"]]
        assert (m["samples_count"], m["correct_count"]) == (test["n"], test["correct"]) and test["n"] > 0
        assert m["accuracy_pct"] == test["accuracy"] * 100
        assert m["balanced_accuracy_pct"] == test["balanced_accuracy"] * 100
    assert out["chosen_lstm"] == entry["lstm"]["config"]


@pytest.mark.parametrize("pair", PAIRS)
def test_month_hit_rate_equals_the_offline_test_predictions(pair: str) -> None:
    year, month = MONTHS[pair]
    out = get_ml_predictions(client(), pair, year, month)
    z = load_npz(ML_MODELS / f"{pair.replace('/', '')}-1h-test{year}-test.npz")
    start = int(datetime(year, month, 1, tzinfo=UTC).timestamp())
    end = int(datetime(year + month // 12, month % 12 + 1, 1, tzinfo=UTC).timestamp())
    sel = [i for i, t in enumerate(z["target_time"]) if start <= t < end]
    n = len(sel)
    assert n > 0
    correct = sum(1 for i in sel if z["pred_lstm"][i] == z["y"][i])
    assert out["scored_count"] == n
    assert out["correct_count"] == correct
    assert out["hit_rate_pct"] == correct / n * 100
    assert out["predicted_up_count"] == sum(1 for i in sel if z["pred_lstm"][i] == 1)
    assert out["predicted_up_count"] + out["predicted_down_count"] == n
    assert out["disclaimer"] == "historical walk-forward test, not live signals"
    assert out["predictions_count"] >= n


@pytest.mark.parametrize(
    ("args", "code"),
    [
        (("EUR/USD", 2015), "OUT_OF_DATA"),
        (("EUR/USD", 2023), "OUT_OF_DATA"),
        (("AUD/USD", 2020), "OUT_OF_DATA"),
        (("EUR/USD", 2020, 13), "INVALID_ARGUMENT"),
        (("EUR/USD", 2020, 0), "INVALID_ARGUMENT"),
    ],
)
def test_refusals_happen_before_any_request(args: tuple[Any, ...], code: str) -> None:
    def no_request(request: httpx.Request) -> httpx.Response:
        raise AssertionError("no request expected")

    with pytest.raises(ToolError) as err:
        get_ml_predictions(client(no_request), *args)
    assert err.value.code == code


@pytest.mark.parametrize(
    ("response", "code"),
    [
        (httpx.Response(401, json={"detail": "Invalid or expired token"}), "UPSTREAM_ERROR"),
        (httpx.Response(500, text="boom"), "UPSTREAM_ERROR"),
        (httpx.Response(422, json={"detail": "the range may cover at most 31 days"}), "INVALID_ARGUMENT"),
    ],
)
def test_upstream_errors_never_echo_the_token(response: httpx.Response, code: str) -> None:
    with pytest.raises(ToolError) as err:
        get_ml_evaluation(client(lambda _r: response), "EUR/USD")
    assert err.value.code == code
    assert TOKEN not in err.value.message


def test_ml_service_down_is_an_upstream_error() -> None:
    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    with pytest.raises(ToolError) as err:
        get_ml_evaluation(client(down), "EUR/USD")
    assert err.value.code == "UPSTREAM_ERROR"


def test_the_client_never_shows_the_token() -> None:
    assert TOKEN not in repr(client())


live = pytest.mark.skipif(os.environ.get("RUN_LIVE_ML") != "true", reason="needs RUN_LIVE_ML=true and ml-service")


@live
@pytest.mark.parametrize("pair", PAIRS)
def test_live_ml_service_gives_the_recorded_results(pair: str) -> None:
    with httpx.Client(base_url=ml_base_url(), timeout=120) as http:
        ml = MlClient(http=http, token=TOKEN)
        assert get_ml_evaluation(ml, pair) == get_ml_evaluation(client(), pair)
        year, month = MONTHS[pair]
        assert get_ml_predictions(ml, pair, year, month) == get_ml_predictions(client(), pair, year, month)


def test_fixture_files_exist() -> None:
    names = sorted(p.name for p in Path(FIXTURES).glob("*.json"))
    assert names == [
        "evaluation.json",
        "predictions-EUR_USD-2022-03.json",
        "predictions-GBP_USD-2019-06.json",
        "predictions-USD_JPY-2020-03.json",
        "predictions-XAU_USD-2017-10.json",
    ]
