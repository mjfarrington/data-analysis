"""
Spark service — manages Spark Connect sessions and DataFrame persistence.
"""
from __future__ import annotations

import asyncio
import logging
import os
import shutil
import time
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional

from app.core.config import settings

logger = logging.getLogger(__name__)

# app_ids that are never permitted as extract output destinations.
# Writing to "default" would pollute the default Spark database / namespace
# and make data impossible to trace back to a pipeline.
_RESERVED_APP_IDS: frozenset[str] = frozenset({"default"})

# Spark Connect is imported lazily to avoid hard dependency at startup
_spark_session: Any = None


def _get_spark():
    """Return a Spark Connect session, creating one if necessary."""
    global _spark_session
    if _spark_session is not None:
        try:
            _spark_session.sql("SELECT 1").collect()
            return _spark_session
        except Exception:
            _spark_session = None

    try:
        from pyspark.sql import SparkSession  # type: ignore
        os.environ.setdefault("SPARK_HOME", settings.SPARK_HOME)
        _spark_session = (
            SparkSession.builder
            .remote(settings.SPARK_CONNECT_URL)
            .getOrCreate()
        )
        logger.info("Connected to Spark at %s", settings.SPARK_CONNECT_URL)
        return _spark_session
    except Exception as exc:
        logger.warning("Spark Connect unavailable: %s", exc)
        raise


def _ensure_namespace_db(spark: Any, db_name: str) -> None:
    """Create a Spark database (catalog namespace) if it does not already exist."""
    # Backtick-quote to handle names like 'markets_20260414'
    spark.sql(f"CREATE DATABASE IF NOT EXISTS `{db_name}`")
    logger.info("Ensured Spark database: %s", db_name)


def _view_name(app_id: str, date_str: str) -> str:
    """Convert app_id + date string to a SQL-safe view name."""
    import re
    return re.sub(r"[^0-9a-zA-Z_]", "_", f"{app_id}__{date_str}")


def _register_file_views(spark: Any, suppress: set | None = None) -> None:
    """Scan the parquet data directory and create temp views for any dataset
    not yet visible in the catalog.  A lightweight no-op when nothing new."""
    base = settings.parquet_path
    if not base.exists():
        return
    try:
        existing = {r.tableName for r in spark.sql("SHOW TABLES").collect()}
    except Exception:
        existing = set()

    for app_dir in sorted(base.iterdir()):
        if not app_dir.is_dir():
            continue
        for date_dir in sorted(app_dir.iterdir()):
            if not date_dir.is_dir():
                continue
            parquet_files = list(date_dir.glob("*.parquet"))
            csv_files = list(date_dir.glob("*.csv"))
            if not parquet_files and not csv_files:
                continue
            view = _view_name(app_dir.name, date_dir.name)
            if view in existing:
                continue
            if suppress and view in suppress:
                continue
            try:
                if parquet_files:
                    df = spark.read.option("recursiveFileLookup", "true").parquet(str(date_dir))
                else:
                    df = spark.read.option("header", "true").option("inferSchema", "true").csv(str(date_dir))
                df.createOrReplaceTempView(view)
                logger.debug("Registered temp view: %s → %s", view, date_dir)
            except Exception as exc:
                logger.warning("Could not register view %s: %s", view, exc)


class SparkService:
    def __init__(self) -> None:
        self._connected = False
        self._suppressed_views: set[str] = set()

    # ─────────────────────────────────────────────────────────────────────
    # Health / status
    # ─────────────────────────────────────────────────────────────────────
    async def test_connection(self) -> dict:
        t0 = time.perf_counter()
        try:
            spark = await asyncio.to_thread(_get_spark)
            result = await asyncio.to_thread(
                lambda: spark.sql("SELECT 1 AS ping").collect()
            )
            latency_ms = (time.perf_counter() - t0) * 1000
            return {
                "connected": True,
                "latency_ms": round(latency_ms, 2),
                "message": "Spark Connect OK",
            }
        except Exception as exc:
            latency_ms = (time.perf_counter() - t0) * 1000
            return {
                "connected": False,
                "latency_ms": round(latency_ms, 2),
                "message": str(exc),
            }

    async def get_master_status(self) -> dict:
        """Fetch Spark Master REST API status."""
        import httpx
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                r = await client.get(f"{settings.SPARK_MASTER_WEBUI}/api/v1/applications")
                r.raise_for_status()
                apps = r.json()
                return {
                    "status": "healthy",
                    "active_apps": sum(1 for a in apps if a.get("attempts", [{}])[-1].get("completed") is False),
                    "total_apps": len(apps),
                }
        except Exception as exc:
            return {"status": "unhealthy", "message": str(exc)}

    async def drop_all_temp_views(self) -> int:
        """Drop every session-scoped temporary view and reset the suppressed-view
        registry.  Called at application startup so there is no stale state from
        a previous session that may have crashed mid-run.

        Returns the count of views dropped (0 if Spark is unreachable).
        """
        self._suppressed_views.clear()

        def _drop() -> int:
            spark = _get_spark()
            dropped = 0
            try:
                rows = spark.sql("SHOW VIEWS").collect()
            except Exception:
                # Older Spark versions may not support SHOW VIEWS
                try:
                    rows = [
                        r for r in spark.sql("SHOW TABLES").collect()
                        if getattr(r, "isTemporary", False)
                    ]
                except Exception:
                    return 0
            for row in rows:
                name = getattr(row, "viewName", None) or getattr(row, "tableName", None)
                if not name:
                    continue
                try:
                    spark.sql(f"DROP VIEW IF EXISTS `{name}`")
                    dropped += 1
                    logger.debug("Startup: dropped temp view %s", name)
                except Exception as exc:
                    logger.warning("Startup: could not drop view %s: %s", name, exc)
            if dropped:
                logger.info("Startup: dropped %d stale temp view(s)", dropped)
            return dropped

        try:
            return await asyncio.to_thread(_drop)
        except Exception as exc:
            logger.debug("Startup temp-view cleanup skipped (Spark unavailable): %s", exc)
            return 0

    # ─────────────────────────────────────────────────────────────────────
    # Data persistence
    # ─────────────────────────────────────────────────────────────────────
    def _parquet_path(self, app_id: str, date: str) -> Path:
        """Return the parquet directory for a given app+date."""
        p = settings.parquet_path / app_id / date
        p.mkdir(parents=True, exist_ok=True)
        return p

    async def save_records_parquet(
        self,
        records: list[dict],
        app_id: str,
        date: str,
        segment: int,
        mode: str = "overwrite",
    ) -> str:
        """Persist a list of Record dicts to parquet via Spark."""
        if app_id.lower() in _RESERVED_APP_IDS:
            raise ValueError(
                f"app_id {app_id!r} is reserved and cannot be used as an extract destination. "
                "Set a meaningful application_id in the pipeline extract config."
            )
        if not records:
            return ""

        def _write() -> str:
            import pandas as pd  # type: ignore
            spark = _get_spark()
            df = spark.createDataFrame(pd.DataFrame(records))
            path = str(self._parquet_path(app_id, date) / f"segment_{segment:04d}.parquet")
            df.write.mode(mode).parquet(path)
            return path

        return await asyncio.to_thread(_write)

    async def save_records_csv(
        self,
        records: list[dict],
        app_id: str,
        date: str,
        segment: int,
    ) -> str:
        """Persist records to CSV (fallback when Spark unavailable)."""
        if app_id.lower() in _RESERVED_APP_IDS:
            raise ValueError(
                f"app_id {app_id!r} is reserved and cannot be used as an extract destination. "
                "Set a meaningful application_id in the pipeline extract config."
            )
        import pandas as pd  # type: ignore

        def _write() -> str:
            path_dir = settings.parquet_path / app_id / date
            path_dir.mkdir(parents=True, exist_ok=True)
            path = str(path_dir / f"segment_{segment:04d}.csv")
            pd.DataFrame(records).to_csv(path, index=False)
            return path

        return await asyncio.to_thread(_write)

    async def merge_and_register_table(
        self,
        app_id: str,
        date: str,
        table_name: Optional[str] = None,
        namespace_db: Optional[str] = None,
        mode: str = "overwrite",
    ) -> str:
        """Merge all segment files for a date into a persistent Spark catalog table.

        When *namespace_db* is provided the table is saved inside that Spark
        database (e.g. ``markets_20260414``), creating it when necessary.  The
        table name within the database is *table_name* if given, otherwise
        ``extracts_{app_id}`` (date is already encoded in the database name).
        Without *namespace_db* the old behaviour is preserved.
        """
        if app_id.lower() in _RESERVED_APP_IDS:
            raise ValueError(
                f"app_id {app_id!r} is reserved and cannot be used as a catalog table destination. "
                "Set a meaningful application_id in the pipeline extract config."
            )
        view = _view_name(app_id, date)

        def _merge():
            spark = _get_spark()
            base_path = settings.parquet_path / app_id / date
            # Prefer parquet segments; fall back to CSV if none exist
            parquet_files = list(base_path.rglob("*.parquet"))
            csv_files = list(base_path.rglob("*.csv"))
            if parquet_files:
                df = spark.read.option("recursiveFileLookup", "true").parquet(str(base_path))
            elif csv_files:
                df = spark.read.option("header", "true").option("inferSchema", "true").csv(str(base_path))
            else:
                raise FileNotFoundError(f"No segment files found under {base_path}")

            if not namespace_db:
                raise ValueError(
                    f"A namespace_db is required to save a Spark catalog table "
                    f"(app_id={app_id!r}, date={date!r}). "
                    "Set use_namespace=True on the pipeline or provide an explicit namespace."
                )
            _ensure_namespace_db(spark, namespace_db)
            # No date in the table name — the database IS the date partition
            base = table_name or f"extracts_{app_id}"
            tbl = f"`{namespace_db}`.`{base}`"

            df.write.mode(mode).saveAsTable(tbl)
            logger.info("Saved catalog table %s (%d rows)", tbl, df.count())

            # Drop the raw file-based temp view so it no longer pollutes default
            try:
                spark.sql(f"DROP VIEW IF EXISTS `{view}`")
                logger.debug("Dropped file temp view: %s", view)
            except Exception as exc:
                logger.warning("Could not drop temp view %s: %s", view, exc)

            return tbl

        result = await asyncio.to_thread(_merge)
        # Suppress this view from being re-registered by _register_file_views
        self._suppressed_views.add(view)
        return result

    # ─────────────────────────────────────────────────────────────────────
    # Query
    # ─────────────────────────────────────────────────────────────────────
    async def execute_query(self, sql: str, limit: int = 500, offset: int = 0, database: Optional[str] = None) -> dict:
        """Run SQL on Spark and return results."""
        import time as _time
        suppressed = frozenset(self._suppressed_views)
        def _run():
            spark = _get_spark()
            # Auto-register file-based data as temp views so SHOW TABLES,
            # DESCRIBE, and SELECT queries can find them immediately.
            _register_file_views(spark, suppress=suppressed)
            # Ensure suppressed views are actually gone from the session
            # (guards against Spark Connect not fully honoring the earlier DROP VIEW)
            for v in suppressed:
                try:
                    spark.sql(f"DROP VIEW IF EXISTS `{v}`")
                except Exception:
                    pass
            # Set active database context so unqualified SHOW TABLES, SELECT etc.
            # resolve against the user-selected database
            if database:
                try:
                    spark.sql(f"USE `{database}`")
                except Exception as exc:
                    logger.warning("Could not USE database %s: %s", database, exc)
            # Rewrite a bare "SHOW TABLES" to be database-qualified so it only
            # returns tables in the selected database (not all temp views globally)
            effective_sql = sql
            if database and sql.strip().upper() == "SHOW TABLES":
                effective_sql = f"SHOW TABLES IN `{database}`"
            t0 = _time.perf_counter()
            df = spark.sql(effective_sql).limit(limit + offset)
            rows_collected = df.collect()
            elapsed = (_time.perf_counter() - t0) * 1000
            columns = df.columns
            rows = [list(row) for row in rows_collected[offset:]]
            return {
                "columns": columns,
                "rows": rows,
                "row_count": len(rows),
                "truncated": len(rows) >= limit,
                "duration_ms": round(elapsed, 2),
            }

        return await asyncio.to_thread(_run)

    async def list_tables(self) -> list[dict]:
        """List available data tables/files."""
        tables = []
        base = settings.parquet_path

        for app_dir in sorted(base.iterdir()) if base.exists() else []:
            if not app_dir.is_dir():
                continue
            for date_dir in sorted(app_dir.iterdir()):
                if not date_dir.is_dir():
                    continue
                parquet_files = list(date_dir.glob("*.parquet"))
                csv_files = list(date_dir.glob("*.csv"))
                files = parquet_files or csv_files
                if not files:
                    continue
                fmt = "parquet" if parquet_files else "csv"
                size = sum(f.stat().st_size for f in files)
                tables.append({
                    "name": f"{app_dir.name}/{date_dir.name}",
                    "path": str(date_dir),
                    "format": fmt,
                    "size_bytes": size,
                    "row_count": None,
                    "columns": [],
                    "partitions": [app_dir.name, date_dir.name],
                    "last_modified": datetime.fromtimestamp(
                        max(f.stat().st_mtime for f in files), tz=timezone.utc
                    ),
                    "file_count": len(files),
                })
        return tables

    @staticmethod
    def _resolve_databases(spark: Any) -> list[tuple[str, str]]:
        """Return list of (short_name, quoted_sql_ref) for all Spark databases.

        Handles Spark 4.x which may return fully-qualified names like
        ``spark_catalog.20260416`` from SHOW DATABASES.  The short name is the
        last component and is used as the ``database`` field in API responses so
        it stays consistent across all catalog queries.
        """
        raw: list[str] = []
        try:
            raw = [r.namespace for r in spark.sql("SHOW DATABASES").collect()]
        except Exception:
            try:
                raw = [r.databaseName for r in spark.sql("SHOW DATABASES").collect()]
            except Exception:
                raw = ["default"]

        result = []
        for name in raw:
            parts = name.split(".")
            short = parts[-1]
            # Quote each component individually so numeric-named DBs work
            quoted = ".".join(f"`{p}`" for p in parts)
            result.append((short, quoted))
        return result

    async def list_databases(self) -> list[str]:
        """Return the short names of all Spark databases (for the UI dropdown)."""
        def _list():
            spark = _get_spark()
            return [short for short, _ in self._resolve_databases(spark)]
        try:
            return await asyncio.to_thread(_list)
        except Exception as exc:
            logger.warning("Could not list databases: %s", exc)
            return ["default"]

    async def list_catalog_tables(self) -> list[dict]:
        """List all tables registered across ALL Spark databases.
        Auto-registers parquet/CSV files from the data directory as temp views
        so that SHOW TABLES always reflects the data on disk.
        """
        suppressed = frozenset(self._suppressed_views)
        def _list():
            spark = _get_spark()
            _register_file_views(spark, suppress=suppressed)
            result = []
            # Session-scoped temp views are global — collect them once so they
            # don't pollute every named database's table list.
            seen_temp_views: set[str] = set()
            for short_db, quoted_ref in self._resolve_databases(spark):
                try:
                    rows = spark.sql(f"SHOW TABLES IN {quoted_ref}").collect()
                    for r in rows:
                        if r.tableName in suppressed:
                            continue
                        if r.isTemporary:
                            # Only emit each temp view once, under 'default'
                            if r.tableName in seen_temp_views:
                                continue
                            seen_temp_views.add(r.tableName)
                            result.append({
                                "database": "default",
                                "name": r.tableName,
                                "is_temporary": True,
                            })
                        else:
                            result.append({
                                "database": short_db,
                                "name": r.tableName,
                                "is_temporary": False,
                            })
                except Exception as exc:
                    logger.warning("Could not list tables in database %s: %s", short_db, exc)
            return result

        return await asyncio.to_thread(_list)

    async def drop_table(self, db: str, table: str) -> None:
        """Drop a specific table from a Spark database, or a session temp view."""
        self._suppressed_views.add(table)
        def _drop():
            spark = _get_spark()
            # Drop as a persistent catalog table (fully-qualified)
            spark.sql(f"DROP TABLE IF EXISTS `{db}`.`{table}`")
            # Drop as a session-scoped temp view — temp views require DROP VIEW,
            # not DROP TABLE, and must be unqualified (no database prefix)
            spark.sql(f"DROP VIEW IF EXISTS `{table}`")
            logger.info("Dropped: %s.%s", db, table)
        await asyncio.to_thread(_drop)

    async def drop_database(self, db: str) -> None:
        """Drop an entire Spark database and all its tables (CASCADE)."""
        def _drop():
            spark = _get_spark()
            spark.sql(f"DROP DATABASE IF EXISTS `{db}` CASCADE")
            logger.info("Dropped database: %s", db)
        await asyncio.to_thread(_drop)

    async def clear_database_tables(self, db: str) -> int:
        """Drop all tables in a database without dropping the database itself."""
        tables = await self.list_catalog_tables()
        db_tables = [t["name"] for t in tables if (t["database"] or "default") == db]
        for table in db_tables:
            await self.drop_table(db, table)
        logger.info("Cleared %d tables from database: %s", len(db_tables), db)
        return len(db_tables)

    async def delete_file_table(self, name: str) -> None:
        """Delete a file store entry (removes the directory on disk)."""
        base = settings.parquet_path
        # name is in the form app_id/date — resolve against the base path
        # and ensure it stays within the parquet root (path traversal guard)
        resolved = (base / name).resolve()
        if not str(resolved).startswith(str(base.resolve())):
            raise ValueError("Invalid table name")
        if not resolved.exists():
            raise FileNotFoundError(f"{name} not found")
        await asyncio.to_thread(shutil.rmtree, resolved)
        logger.info("Deleted file table: %s", resolved)

    async def run_sql_transform(
        self,
        source_db: Optional[str],
        source_table: str,
        sql: str,
        target_db: Optional[str],
        target_table: str,
        mode: str = "overwrite",
    ) -> dict:
        """Execute a SQL transform: register source as 'source', run sql, write result.
        The SQL should SELECT from the alias 'source' (the input dataset).
        Returns dict with row_count and duration_s.
        """
        import time as _time
        suppressed = frozenset(self._suppressed_views)

        def _run():
            spark = _get_spark()
            _register_file_views(spark, suppress=suppressed)

            # Snapshot existing temp views before we add any
            try:
                views_before: set[str] = {r.tableName for r in spark.sql("SHOW VIEWS").collect()}
            except Exception:
                views_before = set()

            # Load source into a temp view called 'source'
            if source_db:
                src_df = spark.table(f"`{source_db}`.`{source_table}`")
            else:
                src_df = spark.table(f"`{source_table}`")
            src_df.createOrReplaceTempView("source")

            try:
                t0 = _time.perf_counter()
                result_df = spark.sql(sql)
                row_count = result_df.count()

                # Write output
                if not target_db:
                    raise ValueError(
                        f"A target_db (namespace) is required to save the transform result "
                        f"(source={source_table!r}, target_table={target_table!r}). "
                        "Set a target database on the transform job."
                    )
                _ensure_namespace_db(spark, target_db)
                tbl = f"`{target_db}`.`{target_table}`"
                result_df.write.mode(mode).saveAsTable(tbl)

                duration = _time.perf_counter() - t0
                logger.info("SQL transform: %s → %s (%d rows, %.2fs)", source_table, tbl, row_count, duration)
                return {"row_count": row_count, "duration_s": round(duration, 2)}
            finally:
                # Drop any temp views created during this run (including 'source')
                try:
                    views_after: set[str] = {r.tableName for r in spark.sql("SHOW VIEWS").collect()}
                    for v in views_after - views_before:
                        spark.sql(f"DROP VIEW IF EXISTS `{v}`")
                        logger.debug("Cleaned up temp view: %s", v)
                except Exception as _exc:
                    logger.warning("Temp view cleanup failed: %s", _exc)

        return await asyncio.to_thread(_run)

    async def run_notebook_transform(
        self,
        source_db: Optional[str],
        source_table: str,
        cells: list[dict],
        target_db: Optional[str],
        target_table: str,
        mode: str = "overwrite",
    ) -> dict:
        """Execute a notebook transform: run code cells in sequence.
        The notebook receives a pre-built 'spark' session and 'source_df' DataFrame.
        The last cell must assign 'result_df' which gets saved to the target table.
        """
        import time as _time
        suppressed = frozenset(self._suppressed_views)

        def _run():
            spark = _get_spark()
            _register_file_views(spark, suppress=suppressed)

            # Snapshot existing temp views before notebook execution
            try:
                views_before: set[str] = {r.tableName for r in spark.sql("SHOW VIEWS").collect()}
            except Exception:
                views_before = set()

            if source_db:
                source_df = spark.table(f"`{source_db}`.`{source_table}`")
            else:
                source_df = spark.table(f"`{source_table}`")

            # Build execution namespace
            ns: dict = {"spark": spark, "source_df": source_df, "result_df": None}

            try:
                t0 = _time.perf_counter()
                for cell in cells:
                    if cell.get("type") != "code":
                        continue
                    src = cell.get("source", "").strip()
                    if not src:
                        continue
                    exec(compile(src, "<notebook_cell>", "exec"), ns)  # noqa: S102

                result_df = ns.get("result_df")
                if result_df is None:
                    raise ValueError("Notebook must assign 'result_df' in the last code cell")

                row_count = result_df.count()
                if not target_db:
                    raise ValueError(
                        f"A target_db (namespace) is required to save the notebook result "
                        f"(source={source_table!r}, target_table={target_table!r}). "
                        "Set a target database on the transform job."
                    )
                _ensure_namespace_db(spark, target_db)
                tbl = f"`{target_db}`.`{target_table}`"
                result_df.write.mode(mode).saveAsTable(tbl)

                duration = _time.perf_counter() - t0
                logger.info("Notebook transform: %s → %s (%d rows, %.2fs)", source_table, tbl, row_count, duration)
                return {"row_count": row_count, "duration_s": round(duration, 2)}
            finally:
                # Drop any temp views created during notebook execution
                try:
                    views_after: set[str] = {r.tableName for r in spark.sql("SHOW VIEWS").collect()}
                    for v in views_after - views_before:
                        spark.sql(f"DROP VIEW IF EXISTS `{v}`")
                        logger.debug("Cleaned up temp view: %s", v)
                except Exception as _exc:
                    logger.warning("Temp view cleanup failed: %s", _exc)

        return await asyncio.to_thread(_run)

    async def preview_transform(
        self,
        source_db: Optional[str],
        source_table: str,
        transform_type: str,
        sql: Optional[str] = None,
        cells: Optional[list[dict]] = None,
        limit: int = 100,
    ) -> dict:
        """Dry-run a transform and return a preview of the result rows.
        Nothing is written to any target table.
        """
        import time as _time
        suppressed = frozenset(self._suppressed_views)

        def _run():
            spark = _get_spark()
            _register_file_views(spark, suppress=suppressed)

            try:
                views_before: set[str] = {r.tableName for r in spark.sql("SHOW VIEWS").collect()}
            except Exception:
                views_before = set()

            if source_db:
                src_df = spark.table(f"`{source_db}`.`{source_table}`")
            else:
                src_df = spark.table(f"`{source_table}`")

            try:
                t0 = _time.perf_counter()

                if transform_type == "sql":
                    if not sql:
                        raise ValueError("sql is required for SQL transform preview")
                    src_df.createOrReplaceTempView("source")
                    result_df = spark.sql(sql)
                else:
                    if not cells:
                        raise ValueError("cells are required for notebook transform preview")
                    ns: dict = {"spark": spark, "source_df": src_df, "result_df": None}
                    for cell in cells:
                        if cell.get("type") != "code":
                            continue
                        src = cell.get("source", "").strip()
                        if not src:
                            continue
                        exec(compile(src, "<notebook_cell>", "exec"), ns)  # noqa: S102
                    result_df = ns.get("result_df")
                    if result_df is None:
                        raise ValueError("Notebook must assign 'result_df'")

                preview_df = result_df.limit(limit)
                rows_collected = preview_df.collect()
                columns = preview_df.columns
                duration = _time.perf_counter() - t0

                return {
                    "columns": columns,
                    "rows": [list(r) for r in rows_collected],
                    "row_count": len(rows_collected),
                    "duration_ms": round(duration * 1000, 2),
                }
            finally:
                try:
                    views_after: set[str] = {r.tableName for r in spark.sql("SHOW VIEWS").collect()}
                    for v in views_after - views_before:
                        spark.sql(f"DROP VIEW IF EXISTS `{v}`")
                        logger.debug("Cleaned up preview temp view: %s", v)
                except Exception as _exc:
                    logger.warning("Preview temp view cleanup failed: %s", _exc)

        return await asyncio.to_thread(_run)


spark_service = SparkService()
