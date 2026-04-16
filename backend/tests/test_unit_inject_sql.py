"""
Unit tests for inject_sql_vars — pure Python, no DB or Spark required.

Covers:
  * All six supported date formats (YYYYMMDD, YYYY-MM-DD, YYYYMM, YYYY/MM/DD,
    DD/MM/YYYY, MM/DD/YYYY)
  * All four range modes (single, current_month, previous_month, custom)
  * Every supported placeholder ($business_date, $business_date_from,
    $business_date_to, $business_date_range)
  * No-date pass-through (business_date=None)
  * Unknown format falls back to YYYYMMDD
  * Correct substitution order — longer placeholders replaced before shorter
    ones that share a common prefix (the historical bug fixed in this session)
"""
from __future__ import annotations

import pytest
from app.services.etl_engine import inject_sql_vars


# ─── Helper ───────────────────────────────────────────────────────────────────

def _inj(sql: str, date: str | None, fmt: str = "YYYYMMDD", mode: str = "single",
         from_iso: str | None = None, to_iso: str | None = None):
    return inject_sql_vars(sql, date, fmt, mode, from_iso, to_iso)


# ─── No-date passthrough ──────────────────────────────────────────────────────

def test_no_date_returns_sql_unchanged():
    sql = "SELECT * FROM t WHERE d = $business_date"
    resolved, variables = _inj(sql, None)
    assert resolved == sql
    assert variables == {}


def test_no_date_empty_variables():
    _, variables = _inj("$business_date_from AND $business_date_to", None)
    assert variables == {}


# ─── Date format variants (single mode) ───────────────────────────────────────

@pytest.mark.parametrize("fmt,expected", [
    ("YYYYMMDD",    "20260416"),
    ("YYYY-MM-DD",  "2026-04-16"),
    ("YYYYMM",      "202604"),
    ("YYYY/MM/DD",  "2026/04/16"),
    ("DD/MM/YYYY",  "16/04/2026"),
    ("MM/DD/YYYY",  "04/16/2026"),
])
def test_all_date_formats_single_mode(fmt: str, expected: str):
    _, variables = _inj("SELECT $business_date", "2026-04-16", fmt, "single")
    assert variables["$business_date"] == expected


def test_unknown_format_falls_back_to_yyyymmdd():
    """Unrecognised format strings fall back silently to YYYYMMDD strftime."""
    _, variables = _inj("$business_date", "2026-04-16", "UNKNOWN_FMT", "single")
    assert variables["$business_date"] == "20260416"


# ─── Single mode — $business_date replacement ─────────────────────────────────

def test_single_mode_substitutes_placeholder():
    resolved, _ = _inj("WHERE dt = $business_date", "2026-04-16")
    assert resolved == "WHERE dt = 20260416"


def test_single_mode_no_leftover_placeholders():
    resolved, _ = _inj("$business_date", "2026-04-16")
    assert "$" not in resolved


def test_single_mode_from_equals_to_equals_base():
    _, variables = _inj("x", "2026-04-16", "YYYYMMDD", "single")
    assert variables["$business_date"] == variables["$business_date_from"] == variables["$business_date_to"]


# ─── current_month mode ───────────────────────────────────────────────────────

def test_current_month_start_is_first_of_month():
    _, v = _inj("x", "2026-04-16", "YYYYMMDD", "current_month")
    assert v["$business_date_from"] == "20260401"


def test_current_month_end_is_last_of_month():
    _, v = _inj("x", "2026-04-16", "YYYYMMDD", "current_month")
    assert v["$business_date_to"] == "20260430"


def test_current_month_feb_non_leap():
    _, v = _inj("x", "2025-02-14", "YYYYMMDD", "current_month")
    assert v["$business_date_from"] == "20250201"
    assert v["$business_date_to"] == "20250228"


def test_current_month_feb_leap():
    _, v = _inj("x", "2024-02-14", "YYYYMMDD", "current_month")
    assert v["$business_date_from"] == "20240201"
    assert v["$business_date_to"] == "20240229"


def test_current_month_december():
    _, v = _inj("x", "2026-12-15", "YYYYMMDD", "current_month")
    assert v["$business_date_from"] == "20261201"
    assert v["$business_date_to"] == "20261231"


# ─── previous_month mode ─────────────────────────────────────────────────────

def test_previous_month_from_april_is_march():
    _, v = _inj("x", "2026-04-16", "YYYYMMDD", "previous_month")
    assert v["$business_date_from"] == "20260301"
    assert v["$business_date_to"] == "20260331"


def test_previous_month_from_january_is_december():
    _, v = _inj("x", "2026-01-15", "YYYYMMDD", "previous_month")
    assert v["$business_date_from"] == "20251201"
    assert v["$business_date_to"] == "20251231"


def test_previous_month_from_march_is_feb_non_leap():
    _, v = _inj("x", "2025-03-01", "YYYYMMDD", "previous_month")
    assert v["$business_date_from"] == "20250201"
    assert v["$business_date_to"] == "20250228"


# ─── custom mode ─────────────────────────────────────────────────────────────

def test_custom_range_uses_explicit_bounds():
    _, v = _inj("x", "2026-04-16", "YYYYMMDD", "custom", "2026-01-01", "2026-04-16")
    assert v["$business_date_from"] == "20260101"
    assert v["$business_date_to"] == "20260416"


def test_custom_range_falls_back_to_single_without_bounds():
    """custom mode without from/to falls back to single (base == from == to)."""
    _, v = _inj("x", "2026-04-16", "YYYYMMDD", "custom", None, None)
    assert v["$business_date_from"] == v["$business_date_to"] == v["$business_date"]


# ─── $business_date_range BETWEEN expansion ───────────────────────────────────

def test_between_expansion_in_current_month():
    resolved, _ = _inj(
        "WHERE dt $business_date_range", "2026-04-16", "YYYYMMDD", "current_month"
    )
    assert "BETWEEN 20260401 AND 20260430" in resolved


def test_between_expansion_in_custom():
    resolved, _ = _inj(
        "BETWEEN_CLAUSE $business_date_range",
        "2026-04-16", "YYYYMMDD", "custom", "2026-02-01", "2026-02-28",
    )
    assert "BETWEEN 20260201 AND 20260228" in resolved


def test_between_expansion_single_mode_same_date():
    _, v = _inj("x", "2026-04-16", "YYYYMMDD", "single")
    assert v["$business_date_range"] == "BETWEEN 20260416 AND 20260416"


# ─── Substitution ordering — the prefix-collision regression ─────────────────

def test_date_from_placeholder_not_corrupted_by_base_replacement():
    """$business_date must NOT corrupt $business_date_from.

    Prior to the fix, replacement was done in dict-insertion order, so
    $business_date (14 chars) was substituted into occurrences of
    $business_date_from (19 chars) before the longer placeholder had a
    chance to be replaced, producing garbled output like "20260416_from".
    """
    resolved, _ = _inj(
        "WHERE start_dt = $business_date_from",
        "2026-04-16", "YYYYMMDD", "current_month",
    )
    assert resolved == "WHERE start_dt = 20260401"


def test_date_to_placeholder_not_corrupted_by_base_replacement():
    resolved, _ = _inj(
        "WHERE end_dt = $business_date_to",
        "2026-04-16", "YYYYMMDD", "current_month",
    )
    assert resolved == "WHERE end_dt = 20260430"


def test_range_placeholder_not_corrupted():
    resolved, _ = _inj(
        "WHERE dt $business_date_range",
        "2026-04-16", "YYYYMMDD", "current_month",
    )
    assert "BETWEEN" in resolved
    assert "$" not in resolved


def test_all_placeholders_in_one_query():
    """All four placeholders used together are each resolved correctly."""
    sql = (
        "SELECT $business_date, $business_date_from, "
        "$business_date_to, $business_date_range"
    )
    resolved, v = _inj(sql, "2026-04-01", "YYYYMMDD", "current_month")
    assert "20260401" in resolved       # $business_date (base)
    assert "20260401" in resolved       # $business_date_from
    assert "20260430" in resolved       # $business_date_to
    assert "BETWEEN" in resolved        # $business_date_range
    assert "$" not in resolved


# ─── Variables dict completeness ─────────────────────────────────────────────

def test_variables_dict_always_has_all_four_keys_when_date_set():
    _, v = _inj("x", "2026-04-16")
    for key in ("$business_date", "$business_date_from", "$business_date_to",
                "$business_date_range"):
        assert key in v, f"Missing key: {key}"


def test_variables_dict_empty_when_no_date():
    _, v = _inj("x", None)
    assert v == {}
