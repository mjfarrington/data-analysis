from __future__ import annotations
import logging
from pathlib import Path
from typing import Optional

import asyncio

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.config import settings
from app.models.etl import ServiceError
from app.schemas.etl import QueryRequest, QueryResult, DataTable, ErrorRecord
from app.services.spark_service import spark_service

router = APIRouter(prefix="/data", tags=["Data"])
logger = logging.getLogger(__name__)


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


@router.delete("/tables/{table_name:path}", status_code=204)
async def delete_file_table(table_name: str):
    """Delete a file store entry (removes directory from disk)."""
    try:
        await spark_service.delete_file_table(table_name)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


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
            # Read all segment files and concatenate
            frames = [pd.read_parquet(f) for f in parquet_files]
            df = pd.concat(frames, ignore_index=True) if len(frames) > 1 else frames[0]
        elif csv_files:
            frames = [pd.read_csv(f) for f in csv_files]
            df = pd.concat(frames, ignore_index=True) if len(frames) > 1 else frames[0]
        else:
            raise FileNotFoundError(f"No parquet or CSV files in {target}")

        total_rows = len(df)
        page = df.iloc[offset: offset + limit]

        # Convert to JSON-safe types
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


@router.get("/catalog")
async def list_catalog_tables():
    """List tables registered in the Spark catalog (visible via SHOW TABLES)."""
    try:
        return await spark_service.list_catalog_tables()
    except Exception as exc:
        logger.warning("Could not list catalog tables: %s", exc)
        return []


@router.get("/catalog/databases")
async def list_catalog_databases():
    """Return all Spark database names (for UI dropdowns, including empty databases)."""
    return await spark_service.list_databases()


@router.delete("/catalog/databases/{db_name}", status_code=204)
async def drop_catalog_database(db_name: str):
    """Drop an entire Spark database and all its tables (CASCADE)."""
    try:
        await spark_service.drop_database(db_name)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.delete("/catalog/{db_name}/tables", status_code=200)
async def clear_catalog_database_tables(db_name: str):
    """Drop all tables in a database without dropping the database itself."""
    try:
        count = await spark_service.clear_database_tables(db_name)
        return {"dropped": count}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.delete("/catalog/{db_name}/{table_name}", status_code=204)
async def drop_catalog_table(db_name: str, table_name: str):
    """Drop a specific table from a Spark database."""
    try:
        await spark_service.drop_table(db_name, table_name)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/errors", response_model=list[ErrorRecord])
async def list_errors(
    service: Optional[str] = None,
    resolved: Optional[bool] = None,
    limit: int = Query(default=100, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    q = select(ServiceError).order_by(desc(ServiceError.timestamp)).limit(limit)
    if service:
        q = q.where(ServiceError.service == service)
    if resolved is not None:
        q = q.where(ServiceError.resolved == resolved)
    result = await db.execute(q)
    return [ErrorRecord.model_validate(e) for e in result.scalars()]


@router.patch("/errors/{error_id}/resolve", response_model=ErrorRecord)
async def resolve_error(error_id: int, db: AsyncSession = Depends(get_db)):
    error = await db.get(ServiceError, error_id)
    if not error:
        raise HTTPException(status_code=404, detail="Error not found")
    error.resolved = True
    await db.commit()
    await db.refresh(error)
    return ErrorRecord.model_validate(error)
