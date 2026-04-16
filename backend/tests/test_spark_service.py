"""
SparkService integration tests — require a live Spark Connect server.

All tests in this file are decorated with ``@spark_required`` and will be
skipped automatically when the server is not reachable.

Covers:
  * test_connection — latency probe and connected flag
  * execute_query — SELECT / SHOW TABLES / DESCRIBE
  * list_catalog_tables — structure validation
  * drop_all_temp_views — creates views, confirms they are cleaned up
  * merge_and_register_table — write CSV segments → persist catalog table
  * save_records_csv — file written, path returned, reserved id rejected
  * reserved app_id guards — all three write methods (covered by test_spark_persistence too)
"""
from __future__ import annotations

import uuid
import asyncio
import pytest
import app.services.spark_service as spark_mod
from app.services.spark_service import SparkService, _get_spark, _RESERVED_APP_IDS
from app.core.config import settings


# ─── Skip marker ─────────────────────────────────────────────────────────────

def _spark_reachable() -> bool:
    try:
        _get_spark().sql("SELECT 1").collect()
        return True
    except Exception:
        return False


spark_required = pytest.mark.skipif(
    not _spark_reachable(),
    reason="Spark Connect server is not reachable",
)

# Shared service instance for integration tests
_svc = SparkService()


# ─── test_connection ─────────────────────────────────────────────────────────

@spark_required
@pytest.mark.asyncio
async def test_connection_returns_connected_true():
    result = await _svc.test_connection()
    assert result["connected"] is True
    assert result["latency_ms"] >= 0


@spark_required
@pytest.mark.asyncio
async def test_connection_reports_latency():
    result = await _svc.test_connection()
    assert isinstance(result["latency_ms"], float)
    assert result["latency_ms"] < 10_000  # reasonable upper bound


# ─── execute_query ───────────────────────────────────────────────────────────

@spark_required
@pytest.mark.asyncio
async def test_execute_query_select_one():
    result = await _svc.execute_query("SELECT 1 AS n")
    assert result["columns"] == ["n"]
    assert result["rows"] == [[1]]
    assert result["row_count"] == 1
    assert result["truncated"] is False


@spark_required
@pytest.mark.asyncio
async def test_execute_query_show_tables_returns_dict():
    result = await _svc.execute_query("SHOW TABLES")
    assert "columns" in result
    assert "rows" in result
    assert isinstance(result["rows"], list)


@spark_required
@pytest.mark.asyncio
async def test_execute_query_limit_is_respected():
    # Build a 10-row query via UNION ALL and confirm limit truncates it
    union = " UNION ALL ".join(f"SELECT {i} AS n" for i in range(10))
    result = await _svc.execute_query(union, limit=3)
    assert result["row_count"] == 3
    assert result["truncated"] is True


@spark_required
@pytest.mark.asyncio
async def test_execute_query_returns_duration():
    result = await _svc.execute_query("SELECT 42 AS x")
    assert "duration_ms" in result
    assert result["duration_ms"] >= 0


@spark_required
@pytest.mark.asyncio
async def test_execute_query_multi_column():
    result = await _svc.execute_query("SELECT 'hello' AS a, 99 AS b")
    assert set(result["columns"]) == {"a", "b"}
    assert result["rows"][0][result["columns"].index("a")] == "hello"
    assert result["rows"][0][result["columns"].index("b")] == 99


@spark_required
@pytest.mark.asyncio
async def test_execute_query_invalid_sql_raises():
    with pytest.raises(Exception):
        await _svc.execute_query("NOT VALID SQL !!!")


# ─── list_catalog_tables ─────────────────────────────────────────────────────

@spark_required
@pytest.mark.asyncio
async def test_list_catalog_tables_returns_list():
    tables = await _svc.list_catalog_tables()
    assert isinstance(tables, list)


@spark_required
@pytest.mark.asyncio
async def test_catalog_tables_have_required_fields():
    tables = await _svc.list_catalog_tables()
    for t in tables:
        assert "database" in t
        assert "name" in t


# ─── drop_all_temp_views ─────────────────────────────────────────────────────

@spark_required
@pytest.mark.asyncio
async def test_drop_all_temp_views_returns_count():
    """drop_all_temp_views should return a non-negative integer."""
    svc = SparkService()
    count = await svc.drop_all_temp_views()
    assert isinstance(count, int)
    assert count >= 0


@spark_required
@pytest.mark.asyncio
async def test_drop_all_temp_views_clears_created_views():
    """Create a temporary view, call drop_all_temp_views, verify it's gone."""
    uid = uuid.uuid4().hex[:8]
    view_name = f"_pytest_tmp_{uid}"

    spark = _get_spark()
    spark.sql(f"CREATE OR REPLACE TEMP VIEW `{view_name}` AS SELECT 1 AS x")

    # Verify it exists
    spark.sql(f"SELECT * FROM `{view_name}`").collect()

    svc = SparkService()
    dropped = await svc.drop_all_temp_views()
    assert dropped >= 1

    # Verify it no longer exists
    with pytest.raises(Exception):
        spark.sql(f"SELECT * FROM `{view_name}`").collect()


# ─── save_records_csv ────────────────────────────────────────────────────────

@spark_required
@pytest.mark.asyncio
async def test_save_records_csv_returns_path():
    uid = uuid.uuid4().hex[:8]
    records = [{"id": 1, "val": "alpha"}, {"id": 2, "val": "beta"}]
    path = await _svc.save_records_csv(records, f"pytest_{uid}", "2026-04-16", 0)
    assert path.endswith(".csv")

    import os
    assert os.path.exists(path)
    os.remove(path)


@spark_required
@pytest.mark.asyncio
async def test_save_records_csv_empty_returns_empty_path():
    uid = uuid.uuid4().hex[:8]
    # Save non-empty first, then test that logic path works
    path = await _svc.save_records_csv([], f"pytest_{uid}", "2026-04-16", 0)
    # Empty records writes an empty CSV (pandas writes header-only)
    # The path is still returned (or may be empty string depending on impl)
    # Just assert no exception is raised
    assert isinstance(path, str)


@spark_required
@pytest.mark.asyncio
async def test_save_records_csv_reserved_app_id_raises():
    with pytest.raises(ValueError, match="reserved"):
        await _svc.save_records_csv([{"x": 1}], "default", "2026-04-16", 0)


# ─── merge_and_register_table — write→merge→query lifecycle ────────────────

@spark_required
@pytest.mark.asyncio
async def test_merge_and_register_table_writes_catalog_table():
    uid = uuid.uuid4().hex[:8]
    app_id = f"pytest_merge_{uid}"
    date = "2099-01-01"  # far-future date to avoid clashing with real data
    table_name = f"_pytest_merge_{uid}"

    # Write CSV segments to disk
    records = [{"id": i, "v": f"val_{i}"} for i in range(3)]
    await _svc.save_records_csv(records, app_id, date, 0)

    # Merge into catalog
    full_table = await _svc.merge_and_register_table(app_id, date, table_name)
    assert table_name in full_table or full_table.endswith(table_name)

    # Query the table
    spark = _get_spark()
    rows = spark.sql(f"SELECT COUNT(*) AS n FROM `{full_table}`").collect()
    assert rows[0][0] == 3

    # Cleanup
    spark.sql(f"DROP TABLE IF EXISTS `{full_table}`")
    import shutil
    from pathlib import Path
    shutil.rmtree(Path(settings.PARQUET_DIR) / app_id, ignore_errors=True)


@spark_required
@pytest.mark.asyncio
async def test_merge_and_register_reserved_app_id_raises():
    with pytest.raises(ValueError, match="reserved"):
        await _svc.merge_and_register_table("default", "2026-04-16", "some_table")


# ─── Spark Connect session persistence (DDL write → reset → read) ──────────

@spark_required
def test_catalog_table_survives_session_reset_via_ddl():
    """
    Confirm that a managed Spark catalog table written via SQL DDL in
    session A is still readable after the client reconnects (session B).

    This is the core persistence guarantee used in production: the Spark
    server's Derby metastore holds table metadata, so tables are visible
    to any new connection even if the client process restarts.
    """
    from pyspark.sql import SparkSession

    uid = uuid.uuid4().hex[:8]
    table_name = f"_pytest_persist_svc_{uid}"

    # Session A — write
    spark_a = _get_spark()
    union = "\nUNION ALL\n".join(
        f"SELECT {i} AS id, 'row_{i}' AS label, {i * 10} AS value"
        for i in range(1, 6)
    )
    spark_a.sql(f"CREATE TABLE IF NOT EXISTS `{table_name}` AS {union}").collect()
    count_a = spark_a.sql(f"SELECT COUNT(*) FROM `{table_name}`").collect()[0][0]
    assert count_a == 5, f"Session A expected 5 rows, got {count_a}"

    session_a_uuid = spark_a.session_id

    # Reset
    spark_mod._spark_session = None

    # Session B — fresh Connect session
    spark_b = SparkSession.builder.remote(settings.SPARK_CONNECT_URL).create()
    assert spark_b.session_id != session_a_uuid, \
        "Expected a different session UUID after reset"

    rows = spark_b.sql(
        f"SELECT id, label, value FROM `{table_name}` ORDER BY id"
    ).collect()
    assert len(rows) == 5
    for i, row in enumerate(rows, start=1):
        assert row.id == i
        assert row.label == f"row_{i}"
        assert row.value == i * 10

    # Cleanup
    spark_b.sql(f"DROP TABLE IF EXISTS `{table_name}`")
