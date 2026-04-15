"""
Spark service — manages Spark Connect sessions and DataFrame persistence.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from datetime import datetime
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional

from app.core.config import settings

logger = logging.getLogger(__name__)

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


def _view_name(app_id: str, date_str: str) -> str:
    """Convert app_id + date string to a SQL-safe view name."""
    import re
    return re.sub(r"[^0-9a-zA-Z_]", "_", f"{app_id}__{date_str}")


def _register_file_views(spark: Any) -> None:
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
        mode: str = "overwrite",
    ) -> str:
        """Merge all segment files for a date into a persistent Spark catalog table."""
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
            tbl = table_name or f"extracts_{app_id}_{date.replace('-', '_')}"
            df.write.mode(mode).saveAsTable(tbl)
            logger.info("Saved catalog table %s (%d rows)", tbl, df.count())
            return tbl

        return await asyncio.to_thread(_merge)

    # ─────────────────────────────────────────────────────────────────────
    # Query
    # ─────────────────────────────────────────────────────────────────────
    async def execute_query(self, sql: str, limit: int = 1000) -> dict:
        """Run SQL on Spark and return results."""
        import time as _time

        def _run():
            spark = _get_spark()
            # Auto-register file-based data as temp views so SHOW TABLES,
            # DESCRIBE, and SELECT queries can find them immediately.
            _register_file_views(spark)
            t0 = _time.perf_counter()
            df = spark.sql(sql).limit(limit)
            rows_collected = df.collect()
            elapsed = (_time.perf_counter() - t0) * 1000
            columns = df.columns
            rows = [list(row) for row in rows_collected]
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
                        max(f.stat().st_mtime for f in files)
                    ),
                    "file_count": len(files),
                })
        return tables

    async def list_catalog_tables(self) -> list[dict]:
        """List all tables registered in the Spark catalog via SHOW TABLES.
        Auto-registers parquet/CSV files from the data directory as temp views
        so that SHOW TABLES always reflects the data on disk.
        """
        def _list():
            spark = _get_spark()
            _register_file_views(spark)
            rows = spark.sql("SHOW TABLES").collect()
            result = []
            for r in rows:
                # Spark 4.x uses 'namespace'; older versions use 'database'
                db = getattr(r, "namespace", None) or getattr(r, "database", "")
                result.append({
                    "database": db,
                    "name": r.tableName,
                    "is_temporary": r.isTemporary,
                })
            return result

        return await asyncio.to_thread(_list)


spark_service = SparkService()
