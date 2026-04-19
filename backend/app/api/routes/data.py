from __future__ import annotations
import asyncio
import logging
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query

from app.core.config import settings
from app.schemas.etl import QueryRequest, QueryResult, DataTable
from app.services.spark_service import spark_service, reset_spark_session, _get_spark

router = APIRouter(prefix="/data", tags=["Data"])
logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Data Browser — list extracted parquet directories
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/browser")
async def list_browser_dirs():
    """List all parquet directories under PARQUET_DIR with basic metadata."""
    base = Path(settings.PARQUET_DIR)

    def _scan():
        entries = []
        if not base.exists():
            return entries
        for item in sorted(base.iterdir()):
            if not item.is_dir():
                continue
            parquet_files = sorted(item.glob("**/*.parquet"))
            csv_files = sorted(item.glob("**/*.csv")) if not parquet_files else []
            files = parquet_files or csv_files
            if not files:
                continue
            total_size = sum(f.stat().st_size for f in files)
            mtime = max(f.stat().st_mtime for f in files)
            entries.append({
                "name": item.name,
                "path": item.name,
                "file_count": len(files),
                "format": "parquet" if parquet_files else "csv",
                "size_bytes": total_size,
                "last_modified": mtime,
            })
        return entries

    return await asyncio.to_thread(_scan)


@router.get("/tables", response_model=list[DataTable])
async def list_data_tables():
    tables = await spark_service.list_tables()
    return [
        DataTable(
            name=t["name"],
            path=t["path"],
            format=t["format"],
            size_bytes=t["size_bytes"],
            row_count=t.get("row_count"),
            columns=t.get("columns", []),
            partitions=t.get("partitions", []),
            last_modified=t.get("last_modified"),
        )
        for t in tables
    ]


@router.get("/tables/{table_name:path}/preview")
async def preview_file_table(
    table_name: str,
    limit: int = Query(default=200, ge=1, le=2000),
    offset: int = Query(default=0, ge=0),
):
    """Preview a parquet/CSV file directly via pandas — no Spark required."""
    import pandas as pd

    # Resolve table_name (date/job/app_id) to the actual directory
    target = settings.parquet_path / table_name
    if not target.exists() or not target.is_dir():
        raise HTTPException(status_code=404, detail=f"No data directory for {table_name!r}")

    # Traverse path guard
    try:
        target.resolve().relative_to(settings.parquet_path.resolve())
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid table path")

    def _read() -> dict:
        parquet_files = sorted(target.glob("*.parquet"))
        csv_files = sorted(target.glob("*.csv"))

        if parquet_files:
            frames = [pd.read_parquet(f) for f in parquet_files]
            df = pd.concat(frames, ignore_index=True) if len(frames) > 1 else frames[0]
        elif csv_files:
            frames = [pd.read_csv(f) for f in csv_files]
            df = pd.concat(frames, ignore_index=True) if len(frames) > 1 else frames[0]
        else:
            raise FileNotFoundError(f"No parquet or CSV files in {target}")

        total_rows = len(df)
        page = df.iloc[offset: offset + limit]

        columns = list(page.columns)
        rows = []
        for _, row in page.iterrows():
            rows.append([None if pd.isna(v) else v for v in row.tolist()])

        return {
            "columns": columns,
            "rows": rows,
            "row_count": len(rows),
            "total_rows": total_rows,
            "truncated": (offset + len(rows)) < total_rows,
            "file_count": len(parquet_files) or len(csv_files),
            "format": "parquet" if parquet_files else "csv",
        }

    try:
        return await asyncio.to_thread(_read)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        logger.exception("Error previewing %s", table_name)
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/query", response_model=QueryResult)
async def execute_query(body: QueryRequest):
    # Basic SQL injection prevention — whitelist-style check for SELECT only
    stripped = body.sql.strip().upper()
    if not stripped.startswith("SELECT") and not stripped.startswith("SHOW") and not stripped.startswith("DESCRIBE"):
        raise HTTPException(
            status_code=400,
            detail="Only SELECT, SHOW, and DESCRIBE statements are allowed",
        )
    try:
        result = await spark_service.execute_query(body.sql, body.limit, body.offset, database=body.database)
        return QueryResult(**result)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


# ─────────────────────────────────────────────────────────────────────────────
# Spark Catalog — databases and tables
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/catalog/databases")
async def list_catalog_databases():
    """List all Spark databases."""
    try:
        return await spark_service.list_databases()
    except Exception as exc:
        logger.exception("Error listing Spark databases")
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/catalog/tables")
async def list_catalog_tables():
    """List all Spark catalog tables and views across all databases."""
    try:
        return await spark_service.list_catalog_tables()
    except Exception as exc:
        logger.exception("Error listing catalog tables")
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/catalog/reconnect")
async def catalog_reconnect():
    """Drop the current Spark session and establish a fresh connection."""
    reset_spark_session()
    try:
        def _connect():
            spark = _get_spark()
            return spark.range(1).collect()
        await asyncio.to_thread(_connect)
        return {"status": "connected"}
    except Exception as exc:
        logger.exception("Spark reconnect failed")
        raise HTTPException(status_code=503, detail=str(exc))


@router.post("/catalog/disconnect")
async def catalog_disconnect():
    """Drop the current Spark Connect session."""
    reset_spark_session()
    return {"status": "disconnected"}


@router.delete("/catalog/views/{view_name}")
async def drop_temp_view(view_name: str):
    """Drop a temporary view by name."""
    try:
        await spark_service.execute_query(f"DROP VIEW IF EXISTS `{view_name}`")
        return {"status": "dropped", "view": view_name}
    except Exception as exc:
        logger.exception("Error dropping view %s", view_name)
        raise HTTPException(status_code=500, detail=str(exc))


@router.delete("/catalog/views")
async def drop_all_temp_views():
    """Drop all temporary views in the current Spark session."""
    try:
        tables = await spark_service.list_catalog_tables()
        temp_views = [t["name"] for t in tables if t.get("is_temporary")]
        for name in temp_views:
            await spark_service.execute_query(f"DROP VIEW IF EXISTS `{name}`")
        return {"status": "dropped", "count": len(temp_views), "views": temp_views}
    except Exception as exc:
        logger.exception("Error dropping all temp views")
        raise HTTPException(status_code=500, detail=str(exc))
