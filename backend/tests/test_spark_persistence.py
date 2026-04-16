"""
Integration test: confirm that data written to a Spark catalog table
is still readable after the client session is reset (simulating a
backend restart while the Spark server keeps running).

Run with:
    cd backend
    .venv/bin/pytest tests/test_spark_persistence.py -v

Requires a live Spark Connect server.  The test is automatically skipped
when the server is unreachable.
"""
from __future__ import annotations

import uuid
import pytest
from pyspark.sql import SparkSession
import app.services.spark_service as spark_mod
from app.services.spark_service import _get_spark
from app.core.config import settings


# ─── Skip fixture ─────────────────────────────────────────────────────────────

def _spark_reachable() -> bool:
    try:
        spark = _get_spark()
        spark.sql("SELECT 1").collect()
        return True
    except Exception:
        return False


spark_required = pytest.mark.skipif(
    not _spark_reachable(),
    reason="Spark Connect server is not reachable — skipping persistence test",
)


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _reset_session() -> None:
    """Simulate a backend restart by discarding the current Spark session.

    The next call to _get_spark() will create a fresh Connect session,
    exactly as happens when the FastAPI process restarts while the Spark
    server remains running.
    """
    spark_mod._spark_session = None


def _table_exists(spark, table: str) -> bool:
    try:
        spark.sql(f"DESCRIBE TABLE {table}").collect()
        return True
    except Exception:
        return False


# ─── Test ─────────────────────────────────────────────────────────────────────

@spark_required
def test_spark_table_persists_across_session_reset():
    """
    Write a small DataFrame to a named Spark table, reset the session,
    reconnect, and verify that the data is still present and correct.

    Lifecycle
    ---------
    1. Session A  — write 5-row table ``_pytest_persist_{uid}`` via SQL DDL
    2. Session reset (simulate backend restart)
    3. Session B  — query the table, assert row count and values match
    4. Cleanup    — drop the test table so the metastore stays tidy

    Note: the table is written using pure SQL (CREATE TABLE … AS SELECT …)
    to avoid a known config-key mismatch between PySpark ≥4.1 client and
    Spark Connect ≤4.0.x servers that occurs with createDataFrame().
    """
    uid = uuid.uuid4().hex[:8]
    table_name = f"_pytest_persist_{uid}"

    # ── Session A: write ──────────────────────────────────────────────────────
    spark_a = _get_spark()
    assert spark_a is not None, "Could not obtain initial Spark session"

    # Build the table with UNION ALL so we avoid createDataFrame entirely
    union_sql = "\nUNION ALL\n".join(
        f"SELECT {i} AS id, 'row_{i}' AS label, {i * 10} AS value"
        for i in range(1, 6)
    )
    spark_a.sql(
        f"CREATE TABLE IF NOT EXISTS `{table_name}` AS {union_sql}"
    ).collect()

    written_count = spark_a.sql(
        f"SELECT COUNT(*) AS n FROM `{table_name}`"
    ).collect()[0][0]
    assert written_count == 5, (
        f"Expected 5 rows written in Session A, got {written_count}"
    )

    session_a_uuid = spark_a.session_id

    # ── Simulate restart ──────────────────────────────────────────────────────
    # In a real restart the process is fresh, so SparkSession's internal cache
    # is empty and getOrCreate() would produce a new session.  Inside the same
    # test process we replicate that by calling .create() directly.
    _reset_session()
    spark_b = (
        SparkSession.builder
        .remote(settings.SPARK_CONNECT_URL)
        .create()
    )

    # ── Session B: reconnect and read ─────────────────────────────────────────
    assert spark_b is not None, "Could not obtain new Spark session after reset"
    assert spark_b.session_id != session_a_uuid, (
        "Expected a fresh Spark session (different session UUID) after reset"
    )

    assert _table_exists(spark_b, table_name), (
        f"Table {table_name!r} is not visible in Session B — "
        "data was NOT persisted to the catalog."
    )

    rows = spark_b.sql(
        f"SELECT id, label, value FROM `{table_name}` ORDER BY id"
    ).collect()

    assert len(rows) == 5, (
        f"Expected 5 rows in Session B, got {len(rows)}"
    )

    for i, row in enumerate(rows, start=1):
        assert row.id == i,              f"Row {i}: id mismatch (got {row.id})"
        assert row.label == f"row_{i}",  f"Row {i}: label mismatch (got {row.label!r})"
        assert row.value == i * 10,      f"Row {i}: value mismatch (got {row.value})"

    # ── Cleanup ───────────────────────────────────────────────────────────────
    spark_b.sql(f"DROP TABLE IF EXISTS `{table_name}`")
    assert not _table_exists(spark_b, table_name), (
        f"Cleanup failed — {table_name!r} still exists after DROP"
    )


@spark_required
def test_reserved_app_id_rejected_by_service():
    """
    The SparkService must refuse to write parquet/csv data or register
    catalog tables when app_id is a reserved name ('default').

    This is a synchronous unit-style check against the guard added to
    save_records_parquet, save_records_csv, and merge_and_register_table.
    """
    import asyncio
    from app.services.spark_service import spark_service

    async def _run():
        # save_records_parquet
        with pytest.raises(ValueError, match="reserved"):
            await spark_service.save_records_parquet(
                [{"x": 1}], app_id="default", date="2026-04-16", segment=0
            )

        # save_records_csv
        with pytest.raises(ValueError, match="reserved"):
            await spark_service.save_records_csv(
                [{"x": 1}], app_id="default", date="2026-04-16", segment=0
            )

        # merge_and_register_table
        with pytest.raises(ValueError, match="reserved"):
            await spark_service.merge_and_register_table(
                app_id="default", date="2026-04-16"
            )

    asyncio.run(_run())


def test_reserved_app_id_rejected_by_engine():
    """
    execute_pipeline must raise a ValueError before touching any storage
    when the extract config has no application_ids (which previously
    silently fell back to 'default').
    """
    import asyncio
    from unittest.mock import AsyncMock, MagicMock
    from app.services.etl_engine import execute_pipeline
    from app.schemas.etl import ExtractConfig, TransformConfig, LoadConfig
    from app.models.etl import ETLRun, RunStatus

    run = MagicMock(spec=ETLRun)
    run.id = 999
    run.status = RunStatus.PENDING
    run.started_at = None
    run.records_extracted = 0
    run.records_transformed = 0
    run.records_loaded = 0
    run.segments_processed = 0

    db = AsyncMock()
    db.commit = AsyncMock()
    db.flush = AsyncMock()
    db.add = MagicMock()

    extract_cfg = ExtractConfig(
        source_type="jdbc",
        application_ids=[],          # ← empty: should be rejected
        jdbc_url="sqlite:///dummy.db",
        jdbc_table="t",
    )

    async def _run():
        await execute_pipeline(
            db, run, extract_cfg, TransformConfig(), LoadConfig()
        )

    asyncio.run(_run())

    # The run should have been marked FAILED with the validation error
    assert run.status == RunStatus.FAILED, (
        f"Expected run status FAILED, got {run.status!r}"
    )
    assert "application_id" in (run.error_message or "").lower(), (
        f"Expected error message about application_id, got: {run.error_message!r}"
    )
