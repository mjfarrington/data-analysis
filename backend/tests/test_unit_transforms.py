"""
Unit tests for _apply_transforms — pure Python, no DB or Spark required.

Covers:
  * drop_columns
  * rename_columns
  * filters (string equality)
  * deduplication with explicit keys
  * combined / chained transforms
  * empty-record pass-through
  * no-op when all config is default
"""
from __future__ import annotations

import pytest
from app.services.etl_engine import _apply_transforms
from app.schemas.etl import TransformConfig


# ─── Helper ───────────────────────────────────────────────────────────────────

def _cfg(**kwargs) -> TransformConfig:
    """Build a TransformConfig, overriding only the supplied fields."""
    defaults = dict(filters={}, drop_columns=[], rename_columns={}, dedup=False, dedup_keys=["id"])
    defaults.update(kwargs)
    return TransformConfig(**defaults)


SAMPLE = [
    {"id": 1, "name": "Alice", "dept": "eng", "score": 90},
    {"id": 2, "name": "Bob",   "dept": "eng", "score": 85},
    {"id": 3, "name": "Carol", "dept": "hr",  "score": 92},
    {"id": 2, "name": "Bob",   "dept": "eng", "score": 85},  # duplicate of row 2
]


# ─── Empty records ────────────────────────────────────────────────────────────

def test_empty_records_returns_empty():
    assert _apply_transforms([], _cfg()) == []


def test_empty_records_with_drop_columns():
    assert _apply_transforms([], _cfg(drop_columns=["x"])) == []


# ─── No-op config ────────────────────────────────────────────────────────────

def test_noop_config_returns_same_records():
    result = _apply_transforms(SAMPLE[:2], _cfg())
    assert result == SAMPLE[:2]


# ─── drop_columns ────────────────────────────────────────────────────────────

def test_drop_single_column():
    result = _apply_transforms(SAMPLE[:1], _cfg(drop_columns=["score"]))
    assert "score" not in result[0]
    assert "id" in result[0]
    assert "name" in result[0]


def test_drop_multiple_columns():
    result = _apply_transforms(SAMPLE[:1], _cfg(drop_columns=["score", "dept"]))
    assert "score" not in result[0]
    assert "dept" not in result[0]
    assert "id" in result[0]


def test_drop_nonexistent_column_is_noop():
    """Dropping a column that doesn't exist should not raise."""
    result = _apply_transforms(SAMPLE[:1], _cfg(drop_columns=["nonexistent"]))
    assert result == SAMPLE[:1]


def test_drop_all_columns_leaves_empty_dicts():
    result = _apply_transforms(
        [{"a": 1}], _cfg(drop_columns=["a"])
    )
    assert result == [{}]


# ─── rename_columns ──────────────────────────────────────────────────────────

def test_rename_single_column():
    result = _apply_transforms(SAMPLE[:1], _cfg(rename_columns={"name": "full_name"}))
    assert "full_name" in result[0]
    assert "name" not in result[0]
    assert result[0]["full_name"] == "Alice"


def test_rename_preserves_value():
    result = _apply_transforms(
        [{"x": 42}], _cfg(rename_columns={"x": "y"})
    )
    assert result[0]["y"] == 42


def test_rename_multiple_columns():
    result = _apply_transforms(
        SAMPLE[:1],
        _cfg(rename_columns={"name": "full_name", "dept": "department"}),
    )
    assert "full_name" in result[0]
    assert "department" in result[0]
    assert "name" not in result[0]
    assert "dept" not in result[0]


def test_rename_nonexistent_column_is_noop():
    """Renaming a column that doesn't exist should not raise."""
    original = [{"a": 1}]
    result = _apply_transforms(original, _cfg(rename_columns={"z": "w"}))
    assert result == original


# ─── filters ────────────────────────────────────────────────────────────────

def test_filter_by_exact_string_value():
    result = _apply_transforms(SAMPLE[:3], _cfg(filters={"dept": "eng"}))
    assert len(result) == 2
    assert all(r["dept"] == "eng" for r in result)


def test_filter_by_integer_value_uses_string_comparison():
    """Filters compare via str() cast on both sides."""
    result = _apply_transforms(SAMPLE[:3], _cfg(filters={"id": "1"}))
    assert len(result) == 1
    assert result[0]["name"] == "Alice"


def test_filter_no_matches_returns_empty():
    result = _apply_transforms(SAMPLE[:3], _cfg(filters={"dept": "finance"}))
    assert result == []


def test_filter_all_match_returns_all():
    records = [{"x": "val"}, {"x": "val"}]
    result = _apply_transforms(records, _cfg(filters={"x": "val"}))
    assert len(result) == 2


def test_multiple_filters_are_anded():
    result = _apply_transforms(
        SAMPLE[:3],
        _cfg(filters={"dept": "eng", "score": "85"}),
    )
    assert len(result) == 1
    assert result[0]["name"] == "Bob"


# ─── deduplication ──────────────────────────────────────────────────────────

def test_dedup_removes_exact_key_duplicate():
    result = _apply_transforms(SAMPLE, _cfg(dedup=True, dedup_keys=["id"]))
    ids = [r["id"] for r in result]
    assert ids.count(2) == 1  # duplicate Bob removed


def test_dedup_preserves_first_occurrence():
    result = _apply_transforms(SAMPLE, _cfg(dedup=True, dedup_keys=["id"]))
    bob = next(r for r in result if r["id"] == 2)
    assert bob["name"] == "Bob"


def test_dedup_false_keeps_duplicates():
    result = _apply_transforms(SAMPLE, _cfg(dedup=False, dedup_keys=["id"]))
    assert len(result) == len(SAMPLE)


def test_dedup_multi_key():
    records = [
        {"a": 1, "b": 2, "c": "x"},
        {"a": 1, "b": 2, "c": "y"},  # same (a,b) key → deduped
        {"a": 1, "b": 3, "c": "z"},  # different b → kept
    ]
    result = _apply_transforms(records, _cfg(dedup=True, dedup_keys=["a", "b"]))
    assert len(result) == 2


def test_dedup_all_unique_keeps_all():
    records = [{"id": i} for i in range(5)]
    result = _apply_transforms(records, _cfg(dedup=True, dedup_keys=["id"]))
    assert len(result) == 5


# ─── Combined transforms ────────────────────────────────────────────────────

def test_drop_then_rename_then_filter():
    cfg = _cfg(
        drop_columns=["score"],
        rename_columns={"dept": "department"},
        filters={"department": "eng"},
        dedup=True,
        dedup_keys=["id"],
    )
    result = _apply_transforms(SAMPLE, cfg)
    # Only eng rows (id=1 Alice, id=2 Bob), duplicate Bob removed
    assert len(result) == 2
    assert all("score" not in r for r in result)
    assert all("dept" not in r for r in result)
    assert all("department" in r for r in result)


def test_rename_then_filter_uses_new_column_name():
    """Filters run AFTER renames, so the renamed column name must be used."""
    cfg = _cfg(
        rename_columns={"dept": "department"},
        filters={"department": "eng"},
    )
    result = _apply_transforms(SAMPLE[:3], cfg)
    assert len(result) == 2
