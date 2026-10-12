"""The structured report. The model fills only SubmitReport (through the submit_report tool);
the tool-call log, data ranges, disclaimer and verification are added by the service."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

# Units a claim may carry: the tool output suffixes that hold numbers (not _utc / _date)
ClaimUnit = Literal["price", "pips", "pct", "usd", "count", "ratio", "p", "lots", "param"]


class Claim(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str = Field(description="what the number is, e.g. 'EUR/USD return 2022'")
    value: str = Field(description="the number exactly as written in the answer, with its sign, e.g. '-6.28'")
    unit: ClaimUnit = Field(description="the unit suffix of the tool result field the value comes from")
    tool_call_id: str = Field(description="id of the tool call whose result holds the value")


class SubmitReport(BaseModel):
    """Submit the final answer. Every number in `answer` must also be a claim."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["answer", "refusal", "not_in_data"]
    answer: str
    claims: list[Claim]


class ToolCallRecord(BaseModel):
    id: str
    name: str
    args: dict[str, object]
    ok: bool
    result_truncated: str


class DataRange(BaseModel):
    tool: str
    pair: str | None = None
    timeframe: str | None = None
    from_date: str | None = None
    to_date: str | None = None
    year: int | None = None
    month: int | None = None
    run_id: str | None = None


class Verification(BaseModel):
    ok: bool
    failures: list[str]
    claims_checked: int
    numbers_checked: int


class Report(BaseModel):
    type: Literal["answer", "refusal", "not_in_data", "could_not_verify"]
    answer: str
    claims: list[Claim]
    tool_calls: list[ToolCallRecord]
    data_ranges: list[DataRange]
    disclaimer: str
    verification: Verification
