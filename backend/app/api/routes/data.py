from __future__ import annotations
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
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
        result = await spark_service.execute_query(body.sql, body.limit)
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
