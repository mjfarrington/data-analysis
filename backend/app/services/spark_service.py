"""
Spark service — manages Spark Connect sessions and DataFrame persistence.
"""
from __future__ import annotations

import asyncio
import json
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
            _spark_session.range(0).count()
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


def reset_spark_session() -> None:
    """Drop the cached Spark Connect session so the next call to _get_spark() reconnects."""
    global _spark_session
    if _spark_session is not None:
        try:
            _spark_session.stop()
        except Exception:
            pass
    _spark_session = None
    logger.info("Spark session reset")


# ─── Notebook interactive session state ───────────────────────────────────────
# Each notebook_id maps to a persistent execution namespace dict.
# Variables assigned in earlier cells survive into later cells.
_notebook_sessions: dict[int, dict] = {}

#: Preamble injected automatically into every new notebook session
_NOTEBOOK_PREAMBLE = """\
from pyspark.sql import functions as F
from pyspark.sql.types import *
from pyspark.sql.window import Window
import pandas as pd

def read_table(table_name, database=None):
    \"\"\"Read a Spark-catalog table into a DataFrame.\"\"\"
    if database:
        return spark.table(f"`{database}`.`{table_name}`")
    return spark.table(f"`{table_name}`")

def show(df, n=20):
    \"\"\"Print a DataFrame preview (alias for df.show).\"\"\"
    df.show(n, truncate=False)

def list_tables(database=None):
    \"\"\"List tables in a database (or the current database).\"\"\"
    if database:
        spark.sql(f"SHOW TABLES IN `{database}`").show(truncate=False)
    else:
        spark.sql("SHOW TABLES").show(truncate=False)
"""


def _ensure_namespace_db(spark: Any, db_name: str) -> None:
    """Create a Spark database (catalog namespace) if it does not already exist."""
    # Backtick-quote to handle names like 'markets_20260414'
    spark.sql(f"CREATE DATABASE IF NOT EXISTS `{db_name}`")
    logger.info("Ensured Spark database: %s", db_name)


def _view_name(date_str: str, job_name: str, app_id: str) -> str:
    """Convert date + dataset path tokens to a SQL-safe view name.

    Must match the formula in DataExplorer.tsx handlePreviewFile:
      parts = name.split('/')  // ['2026-04-17', 'TEST_GRPC', '1']
      (parts[0] + '__' + parts.slice(1).join('/')).replace(/[^0-9a-zA-Z_]/g, '_').toLowerCase()
    e.g. '2026_04_17__my_pipeline_extract_positions_app_1'
    """
    import re
    return re.sub(r"[^0-9a-zA-Z_]", "_", f"{date_str}__{job_name}/{app_id}").lower()


def _safe_path_token(value: Optional[str], fallback: str) -> str:
    import re
    token = re.sub(r"[^A-Za-z0-9]+", "_", (value or "").strip()).strip("_")
    return token.upper() if token else fallback


def _register_file_views(spark: Any, suppress: set | None = None) -> None:
    """Scan the parquet data directory and create temp views for any dataset
    not yet visible in the catalog.  A lightweight no-op when nothing new.

    Directory structure: <date>/<pipeline>/<extract_label>/<app_id?>/
    Also drops any temp views that no longer correspond to a file on disk
    (e.g. old-format views from a previous code version).
    """
    base = settings.parquet_path
    if not base.exists():
        return
    try:
        existing_rows = spark.sql("SHOW TABLES").collect()
        existing = {r.tableName for r in existing_rows}
        existing_temp = {r.tableName for r in existing_rows if getattr(r, "isTemporary", False)}
    except Exception:
        existing = set()
        existing_temp = set()

    # Build dataset roots and valid view names from current disk state.
    # Dataset key format: "<date>|<pipeline>/<extract_label>[/<app_id>]"
    dataset_roots: dict[str, Path] = {}
    valid_views: set[str] = set()
    for date_dir in sorted(base.iterdir()):
        if not date_dir.is_dir():
            continue
        for pipeline_dir in sorted(date_dir.iterdir()):
            if not pipeline_dir.is_dir():
                continue
            for extract_dir in sorted(pipeline_dir.iterdir()):
                if not extract_dir.is_dir():
                    continue
                extract_files = list(extract_dir.glob("*.parquet")) + list(extract_dir.glob("*.csv"))
                if extract_files:
                    key = f"{date_dir.name}|{pipeline_dir.name}/{extract_dir.name}"
                    dataset_roots[key] = extract_dir
                    valid_views.add(_view_name(date_dir.name, f"{pipeline_dir.name}/{extract_dir.name}", ""))

                for app_dir in sorted(extract_dir.iterdir()):
                    if not app_dir.is_dir():
                        continue
                    app_files = list(app_dir.glob("*.parquet")) + list(app_dir.glob("*.csv"))
                    if not app_files:
                        continue
                    key = f"{date_dir.name}|{pipeline_dir.name}/{extract_dir.name}/{app_dir.name}"
                    dataset_roots[key] = app_dir
                    valid_views.add(_view_name(date_dir.name, f"{pipeline_dir.name}/{extract_dir.name}", app_dir.name))

    # Drop stale temp views (e.g. from old naming scheme or deleted data)
    for stale in existing_temp - valid_views - (suppress or set()):
        try:
            spark.sql(f"DROP VIEW IF EXISTS `{stale}`")
            logger.info("Dropped stale temp view: %s", stale)
        except Exception as exc:
            logger.warning("Could not drop stale view %s: %s", stale, exc)
        existing.discard(stale)

    for key, root in dataset_roots.items():
        date_part, rel_part = key.split("|", 1)
        rel_tokens = [p for p in rel_part.split("/") if p]
        if len(rel_tokens) < 2:
            continue
        view_job = f"{rel_tokens[0]}/{rel_tokens[1]}"
        view_app = rel_tokens[2] if len(rel_tokens) >= 3 else ""
        view = _view_name(date_part, view_job, view_app)
        if view in existing:
            continue
        if suppress and view in suppress:
            continue
        try:
            parquet_files = list(root.glob("*.parquet"))
            csv_files = list(root.glob("*.csv"))
            if parquet_files:
                df = spark.read.option("recursiveFileLookup", "true").parquet(str(root))
            elif csv_files:
                df = spark.read.option("header", "true").option("inferSchema", "true").csv(str(root))
            else:
                continue
            df.createOrReplaceTempView(view)
            logger.debug("Registered temp view: %s → %s", view, root)
        except Exception as exc:
            logger.warning("Could not register view %s: %s", view, exc)


class SparkService:
    _SUPPRESSED_FILE = Path(settings.DATA_DIR) / ".suppressed_views.json"

    def __init__(self) -> None:
        self._connected = False
        self._suppressed_views: set[str] = self._load_suppressed()

    def _load_suppressed(self) -> set[str]:
        """Load the persisted suppressed-views set from disk."""
        try:
            data = json.loads(self._SUPPRESSED_FILE.read_text())
            if isinstance(data, list):
                return set(data)
        except (FileNotFoundError, json.JSONDecodeError):
            pass
        return set()

    def _save_suppressed(self) -> None:
        """Persist the suppressed-views set to disk so it survives restarts."""
        try:
            self._SUPPRESSED_FILE.write_text(json.dumps(sorted(self._suppressed_views)))
        except Exception as exc:
            logger.warning("Could not persist suppressed views: %s", exc)

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
        """Drop every session-scoped temporary view that is not in the persisted
        suppressed-views list.  Called at application startup to clean up stale
        views left over from a crashed or restarted session.

        The suppressed-views list is intentionally preserved so that tables the
        user explicitly deleted do not reappear after a restart.

        Returns the count of views dropped (0 if Spark is unreachable).
        """
        suppressed = frozenset(self._suppressed_views)

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
                if not name or name in suppressed:
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
    def _parquet_path(
        self,
        date: str,
        pipeline_name: str,
        extract_label: str,
        app_id: Optional[str],
    ) -> Path:
        """Return the parquet directory: <parquet_root>/<date>/<pipeline>/<extract_label>/<app_id?>/"""
        pipe = _safe_path_token(pipeline_name, "PIPELINE")
        extract = _safe_path_token(extract_label, "EXTRACT")
        p = settings.parquet_path / date / pipe / extract
        app = (app_id or "").strip()
        if app:
            p = p / _safe_path_token(app, app)
        p.mkdir(parents=True, exist_ok=True)
        return p

    async def save_records_parquet(
        self,
        records: list[dict],
        app_id: Optional[str],
        date: str,
        segment: int,
        mode: str = "overwrite",
        job_name: str = "PIPELINE",
        pipeline_name: Optional[str] = None,
        extract_label: Optional[str] = None,
    ) -> str:
        """Persist a list of Record dicts to parquet using pandas.

        Output path: <parquet_root>/<date>/<pipeline>/<extract_label>/<app_id?>/segment_NNNN.parquet
        """
        app_value = (app_id or "").strip()
        if app_value and app_value.lower() in _RESERVED_APP_IDS:
            raise ValueError(
                f"app_id {app_value!r} is reserved and cannot be used as an extract destination. "
                "Set a meaningful application_id in the pipeline extract config."
            )
        if not records:
            return ""

        def _write() -> str:
            import pandas as pd  # type: ignore
            dest = self._parquet_path(
                date,
                pipeline_name or job_name,
                extract_label or job_name,
                app_value or None,
            )
            path = str(dest / f"segment_{segment:04d}.parquet")
            pd.DataFrame(records).to_parquet(path, index=False)
            return path

        return await asyncio.to_thread(_write)

    async def save_records_csv(
        self,
        records: list[dict],
        app_id: Optional[str],
        date: str,
        segment: int,
        job_name: str = "PIPELINE",
        pipeline_name: Optional[str] = None,
        extract_label: Optional[str] = None,
    ) -> str:
        """Persist records to CSV.

        Output path: <parquet_root>/<date>/<pipeline>/<extract_label>/<app_id?>/segment_NNNN.csv
        """
        app_value = (app_id or "").strip()
        if app_value and app_value.lower() in _RESERVED_APP_IDS:
            raise ValueError(
                f"app_id {app_value!r} is reserved and cannot be used as an extract destination. "
                "Set a meaningful application_id in the pipeline extract config."
            )
        import pandas as pd  # type: ignore

        def _write() -> str:
            dest = self._parquet_path(
                date,
                pipeline_name or job_name,
                extract_label or job_name,
                app_value or None,
            )
            path = str(dest / f"segment_{segment:04d}.csv")
            pd.DataFrame(records).to_csv(path, index=False)
            return path

        return await asyncio.to_thread(_write)

    async def merge_and_register_table(
        self,
        app_id: str,
        date: str,
        job_name: str = "PIPELINE",
        table_name: Optional[str] = None,
        namespace_db: Optional[str] = None,
        mode: str = "overwrite",
        pipeline_name: Optional[str] = None,
        extract_label: Optional[str] = None,
    ) -> str:
        """Merge all segment files for one app_id into a persistent Spark catalog table.

        Reads from: <parquet_root>/<date>/<pipeline>/<extract_label>/<app_id>/
        """
        if app_id.lower() in _RESERVED_APP_IDS:
            raise ValueError(
                f"app_id {app_id!r} is reserved and cannot be used as a catalog table destination. "
                "Set a meaningful application_id in the pipeline extract config."
            )
        if not namespace_db:
            raise ValueError(
                f"A namespace_db is required to save a Spark catalog table "
                f"(app_id={app_id!r}, date={date!r})."
            )
        view = _view_name(date, job_name, app_id)

        def _merge():
            spark = _get_spark()
            base_path = self._parquet_path(
                date,
                pipeline_name or job_name,
                extract_label or job_name,
                app_id,
            )
            parquet_files = sorted(str(p) for p in base_path.rglob("*.parquet"))
            csv_files = sorted(str(p) for p in base_path.rglob("*.csv"))
            if parquet_files:
                df = spark.read.parquet(*parquet_files)
            elif csv_files:
                df = spark.read.option("header", "true").option("inferSchema", "true").csv(csv_files)
            else:
                raise FileNotFoundError(f"No segment files found under {base_path}")

            _ensure_namespace_db(spark, namespace_db)
            base = table_name or job_name.lower() if job_name else f"extracts_{app_id}"
            tbl = f"`{namespace_db}`.`{base}`"
            df.write.mode(mode).saveAsTable(tbl)
            logger.info("Saved catalog table %s", tbl)

            try:
                spark.sql(f"DROP VIEW IF EXISTS `{view}`")
            except Exception as exc:
                logger.warning("Could not drop temp view %s: %s", view, exc)
            return tbl

        result = await asyncio.to_thread(_merge)
        self._suppressed_views.add(view)
        # Re-expose the persistent table name in case it was previously suppressed
        _tbl_name = table_name or (job_name.lower() if job_name else f"extracts_{app_id}")
        self._suppressed_views.discard(_tbl_name)
        self._save_suppressed()
        return result

    async def load_to_spark_table(
        self,
        date: str,
        job_name: str,
        namespace_db: str,
        table_name: Optional[str] = None,
        mode: str = "overwrite",
        pipeline_name: Optional[str] = None,
        extract_label: Optional[str] = None,
    ) -> dict:
        """Consolidate all app_id sub-directories under <date>/<pipeline>/<extract_label>/ into one
        Spark catalog table, adding an *application_id* column to each shard.

        Returns a dict with the table name and row count.
        """
        pipeline_token = _safe_path_token(pipeline_name or job_name, "PIPELINE")
        extract_token = _safe_path_token(extract_label or job_name, "EXTRACT")
        base_dir = settings.parquet_path / date / pipeline_token / extract_token
        if not base_dir.exists():
            raise FileNotFoundError(
                f"No output directory found for date={date!r} pipeline={pipeline_token!r} extract={extract_token!r} "
                f"(expected {base_dir})"
            )

        app_dirs = [d for d in sorted(base_dir.iterdir()) if d.is_dir()]
        root_parquet = sorted(str(p) for p in base_dir.glob("*.parquet"))
        root_csv = sorted(str(p) for p in base_dir.glob("*.csv"))
        if not app_dirs and not root_parquet and not root_csv:
            raise FileNotFoundError(f"No app_id directories or segment files found under {base_dir}")

        def _load():
            spark = _get_spark()
            from pyspark.sql import functions as F  # type: ignore

            frames = []
            if root_parquet:
                root_df = spark.read.parquet(*root_parquet)
                root_df = root_df.withColumn("application_id", F.lit(None).cast("string"))
                frames.append(root_df)
            elif root_csv:
                root_df = spark.read.option("header", "true").option("inferSchema", "true").csv(root_csv)
                root_df = root_df.withColumn("application_id", F.lit(None).cast("string"))
                frames.append(root_df)

            for app_dir in app_dirs:
                parquet_files = sorted(str(p) for p in app_dir.rglob("*.parquet"))
                csv_files = sorted(str(p) for p in app_dir.rglob("*.csv"))
                if parquet_files:
                    df = spark.read.parquet(*parquet_files)
                elif csv_files:
                    df = spark.read.option("header", "true").option("inferSchema", "true").csv(csv_files)
                else:
                    continue
                df = df.withColumn("application_id", F.lit(app_dir.name))
                frames.append(df)

            if not frames:
                raise FileNotFoundError(f"No readable segment files found under {base_dir}")

            combined = frames[0]
            for frame in frames[1:]:
                combined = combined.unionByName(frame, allowMissingColumns=True)

            _ensure_namespace_db(spark, namespace_db)
            tbl_name = table_name or job_name.lower()
            tbl = f"`{namespace_db}`.`{tbl_name}`"
            combined.write.mode(mode).saveAsTable(tbl)
            count = combined.count()
            logger.info("Loaded %d rows into %s from %d source folder(s)", count, tbl, len(frames))
            return tbl, count, len(frames)

        tbl, count, n_apps = await asyncio.to_thread(_load)
        # Re-expose the persistent table name in case it was previously suppressed
        _tbl_name = table_name or job_name.lower()
        self._suppressed_views.discard(_tbl_name)
        self._save_suppressed()
        return {
            "table": tbl,
            "rows_loaded": count,
            "app_ids_merged": n_apps,
            "job_name": job_name,
            "date": date,
            "pipeline_name": pipeline_token,
            "extract_label": extract_token,
        }

    async def save_records_to_spark_table(
        self,
        records: list[dict],
        namespace_db: str,
        table_name: str,
        mode: str = "append",
    ) -> dict:
        """Write in-memory records directly to a Spark table (no parquet staging path)."""
        if not namespace_db:
            raise ValueError("namespace_db is required")
        if not table_name:
            raise ValueError("table_name is required")
        if not records:
            tbl = f"`{namespace_db}`.`{table_name}`"
            return {"table": tbl, "rows_loaded": 0}

        def _write() -> tuple[str, int]:
            import pandas as pd  # type: ignore
            spark = _get_spark()
            _ensure_namespace_db(spark, namespace_db)
            df = spark.createDataFrame(pd.DataFrame(records))
            tbl = f"`{namespace_db}`.`{table_name}`"
            df.write.mode(mode).saveAsTable(tbl)
            return tbl, int(df.count())

        tbl, rows = await asyncio.to_thread(_write)
        self._suppressed_views.discard(table_name)
        self._save_suppressed()
        return {"table": tbl, "rows_loaded": rows}

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

    async def execute_query_bulk(self, sql: str, max_rows: int = 100_000, database: Optional[str] = None) -> dict:
        """Run SQL on Spark and return up to max_rows quickly in a single pass."""
        import time as _time

        suppressed = frozenset(self._suppressed_views)

        def _run():
            spark = _get_spark()
            _register_file_views(spark, suppress=suppressed)
            for v in suppressed:
                try:
                    spark.sql(f"DROP VIEW IF EXISTS `{v}`")
                except Exception:
                    pass
            if database:
                try:
                    spark.sql(f"USE `{database}`")
                except Exception as exc:
                    logger.warning("Could not USE database %s: %s", database, exc)

            effective_sql = sql
            if database and sql.strip().upper() == "SHOW TABLES":
                effective_sql = f"SHOW TABLES IN `{database}`"

            t0 = _time.perf_counter()
            df = spark.sql(effective_sql)
            sampled = df.limit(max_rows + 1)
            rows_collected = sampled.collect()
            elapsed = (_time.perf_counter() - t0) * 1000

            is_truncated = len(rows_collected) > max_rows
            rows = [list(row) for row in rows_collected[:max_rows]]
            return {
                "columns": df.columns,
                "rows": rows,
                "row_count": len(rows),
                "truncated": is_truncated,
                "duration_ms": round(elapsed, 2),
            }

        return await asyncio.to_thread(_run)

    async def list_tables(self) -> list[dict]:
        """List available data tables/files.

        Directory structure: <parquet_root>/<date>/<job_name>/<app_id>/
        Each app_id leaf directory with segment files becomes one entry.
        """
        tables = []
        base = settings.parquet_path

        for date_dir in sorted(base.iterdir()) if base.exists() else []:
            if not date_dir.is_dir():
                continue
            for job_dir in sorted(date_dir.iterdir()):
                if not job_dir.is_dir():
                    continue
                for app_dir in sorted(job_dir.iterdir()):
                    if not app_dir.is_dir():
                        continue
                    parquet_files = list(app_dir.glob("*.parquet"))
                    csv_files = list(app_dir.glob("*.csv"))
                    files = parquet_files or csv_files
                    if not files:
                        continue
                    fmt = "parquet" if parquet_files else "csv"
                    size = sum(f.stat().st_size for f in files)
                    tables.append({
                        "name": f"{date_dir.name}/{job_dir.name}/{app_dir.name}",
                        "path": str(app_dir),
                        "format": fmt,
                        "size_bytes": size,
                        "row_count": None,
                        "columns": [],
                        "partitions": [date_dir.name, job_dir.name, app_dir.name],
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
        # Reload from disk so changes (e.g. unsuppressing a table after re-run) take effect
        # without requiring a server restart.
        self._suppressed_views = self._load_suppressed()
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
        self._save_suppressed()
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
        source_table: Optional[str],
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

            # Optional source alias support for transform-job mode.
            # In pipeline SQL-only mode we run the query directly against
            # fully-qualified tables in source_db without a fixed 'source' view.
            if source_db:
                db_rows = spark.sql("SHOW DATABASES").collect()
                available_dbs: list[str] = []
                for r in db_rows:
                    # Spark versions differ in column name (namespace/databaseName)
                    val = getattr(r, "namespace", None) or getattr(r, "databaseName", None)
                    if val:
                        available_dbs.append(str(val))
                if source_db not in available_dbs:
                    raise ValueError(
                        f"Source database '{source_db}' was not found in Spark catalog. "
                        f"Available: {', '.join(sorted(available_dbs))}"
                    )
                spark.sql(f"USE `{source_db}`")
            if source_table:
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
                logger.info("SQL transform: %s → %s (%d rows, %.2fs)", source_table or "<query>", tbl, row_count, duration)
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

    # ─── Interactive notebook execution ──────────────────────────────────────

    async def execute_notebook_cells(
        self,
        nb_id: int,
        cells: list[dict],
        reset_session: bool = False,
    ) -> list[dict]:
        """Execute a list of cells interactively.

        Each cell runs in a persistent per-notebook namespace so variables defined
        in earlier cells are available in later ones.  The preamble (spark helpers,
        common imports) is injected once at session start.

        Returns a list of output dicts, one per code cell::

            {cell_id, stdout, error, df_preview, execution_time_ms}

        ``df_preview`` is set when the cell's last expression or a variable named
        ``result_df`` / ``df`` / ``output_df`` evaluates to a Spark DataFrame.
        """
        import io
        import time as _time
        import traceback
        from contextlib import redirect_stdout

        if reset_session:
            _notebook_sessions.pop(nb_id, None)

        suppressed = frozenset(self._suppressed_views)

        def _run_cells() -> list[dict]:
            spark = _get_spark()
            _register_file_views(spark, suppress=suppressed)

            # Initialise namespace with preamble + spark on first use
            if nb_id not in _notebook_sessions:
                ns: dict = {"spark": spark}
                buf = io.StringIO()
                try:
                    with redirect_stdout(buf):
                        exec(compile(_NOTEBOOK_PREAMBLE, "<preamble>", "exec"), ns)  # noqa: S102
                except Exception as exc:
                    logger.warning("Preamble exec failed: %s", exc)
                _notebook_sessions[nb_id] = ns
            else:
                ns = _notebook_sessions[nb_id]
                ns["spark"] = spark  # refresh spark handle in case of reconnect

            outputs: list[dict] = []
            for cell in cells:
                if cell.get("type") != "code":
                    continue
                src = (cell.get("source") or cell.get("content") or "").strip()
                cell_id = cell.get("id", "")
                if not src:
                    continue

                buf = io.StringIO()
                t0 = _time.perf_counter()
                error_text: str | None = None
                df_preview: dict | None = None

                try:
                    with redirect_stdout(buf):
                        exec(compile(src, f"<cell:{cell_id}>", "exec"), ns)  # noqa: S102
                except Exception:
                    error_text = traceback.format_exc()

                elapsed_ms = round((_time.perf_counter() - t0) * 1000)

                # Look for a displayable DataFrame in the namespace
                if error_text is None:
                    candidate = None
                    for var_name in ("result_df", "output_df", "df"):
                        v = ns.get(var_name)
                        if v is not None:
                            try:
                                from pyspark.sql import DataFrame as _DF  # noqa: PLC0415
                                if isinstance(v, _DF):
                                    candidate = v
                                    break
                            except ImportError:
                                pass
                    if candidate is not None:
                        try:
                            rows = candidate.limit(100).collect()
                            cols = candidate.columns
                            df_preview = {
                                "columns": cols,
                                "rows": [[str(r[c]) if r[c] is not None else None for c in cols] for r in rows],
                                "row_count": len(rows),
                            }
                        except Exception as exc:
                            df_preview = None
                            logger.debug("df_preview failed: %s", exc)

                outputs.append({
                    "cell_id": cell_id,
                    "stdout": buf.getvalue(),
                    "error": error_text,
                    "df_preview": df_preview,
                    "execution_time_ms": elapsed_ms,
                })

            return outputs

        return await asyncio.to_thread(_run_cells)

    async def export_notebook_result(
        self,
        nb_id: int,
        target_db: str,
        target_table: str,
        source_var: str = "result_df",
        mode: str = "overwrite",
    ) -> dict:
        """Write a DataFrame from the notebook session to a Spark table.

        ``source_var`` names the namespace variable holding the DataFrame
        (defaults to ``result_df``).
        """
        import time as _time

        suppressed = frozenset(self._suppressed_views)

        def _export() -> dict:
            ns = _notebook_sessions.get(nb_id)
            if ns is None:
                raise ValueError("No active notebook session — run the notebook first")
            df = ns.get(source_var)
            if df is None:
                raise ValueError(
                    f"Variable '{source_var}' not found in notebook session. "
                    "Make sure your notebook assigns it before exporting."
                )
            try:
                from pyspark.sql import DataFrame as _DF  # noqa: PLC0415
                if not isinstance(df, _DF):
                    raise TypeError(f"'{source_var}' is not a Spark DataFrame (got {type(df).__name__})")
            except ImportError:
                pass

            spark = _get_spark()
            _register_file_views(spark, suppress=suppressed)
            _ensure_namespace_db(spark, target_db)
            tbl = f"`{target_db}`.`{target_table}`"
            t0 = _time.perf_counter()
            row_count = df.count()
            df.write.mode(mode).saveAsTable(tbl)
            duration = _time.perf_counter() - t0
            logger.info("Notebook export: %s.%s → %s (%d rows, %.2fs)", target_db, target_table, tbl, row_count, duration)
            return {"table": tbl, "row_count": row_count, "duration_s": round(duration, 2)}

        return await asyncio.to_thread(_export)


spark_service = SparkService()
