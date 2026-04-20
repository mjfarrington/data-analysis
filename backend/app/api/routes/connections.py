"""
CRUD routes for named Connection records.

Passwords are stored Fernet-encrypted (app.services.crypto).
If CONNECTIONS_SECRET_KEY is not configured, the password is stored as None
and a warning is emitted — the connection can still be saved / used for
metadata purposes.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db
from app.models.etl import Connection, Dictionary
from app.schemas.etl import ConnectionCreate, ConnectionResponse, ConnectionUpdate
from sqlalchemy.orm import selectinload
from app.services.crypto import encrypt_password
from app.services import jdbc_service

router = APIRouter(prefix="/connections", tags=["connections"])


# ─────────────────────────────────────────────────────────────────────────────
# List
# ─────────────────────────────────────────────────────────────────────────────

@router.get("", response_model=list[ConnectionResponse])
async def list_connections(db: AsyncSession = Depends(get_db)):
    res = await db.execute(select(Connection).order_by(Connection.name))
    return res.scalars().all()


# ─────────────────────────────────────────────────────────────────────────────
# Create
# ─────────────────────────────────────────────────────────────────────────────

@router.post("", response_model=ConnectionResponse, status_code=201)
async def create_connection(
    body: ConnectionCreate,
    db: AsyncSession = Depends(get_db),
):
    conn = Connection(
        name=body.name,
        description=body.description,
        conn_type=body.conn_type,
        host=body.host,
        port=body.port,
        database=body.database,
        username=body.username,
        extra=body.extra or {},
    )
    if body.password:
        conn.password_encrypted = encrypt_password(body.password)
    db.add(conn)
    await db.commit()
    await db.refresh(conn)
    return conn


# ─────────────────────────────────────────────────────────────────────────────
# Update
# ─────────────────────────────────────────────────────────────────────────────

@router.put("/{conn_id}", response_model=ConnectionResponse)
async def update_connection(
    conn_id: int,
    body: ConnectionUpdate,
    db: AsyncSession = Depends(get_db),
):
    conn = await db.get(Connection, conn_id)
    if not conn:
        raise HTTPException(status_code=404, detail="Connection not found")

    for field in ("name", "description", "conn_type", "host", "port", "database", "username", "extra"):
        val = getattr(body, field)
        if val is not None:
            setattr(conn, field, val)

    # Empty string clears the password; a non-empty value re-encrypts it
    if body.password is not None:
        conn.password_encrypted = (
            encrypt_password(body.password) if body.password else None
        )

    conn.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(conn)
    return conn


# ─────────────────────────────────────────────────────────────────────────────
# Delete
# ─────────────────────────────────────────────────────────────────────────────

@router.delete("/{conn_id}", status_code=204)
async def delete_connection(
    conn_id: int,
    db: AsyncSession = Depends(get_db),
):
    conn = await db.get(Connection, conn_id)
    if not conn:
        raise HTTPException(status_code=404, detail="Connection not found")
    await db.delete(conn)
    await db.commit()


# ─────────────────────────────────────────────────────────────────────────────
# Test connection (adhoc — no saved record required)
# ─────────────────────────────────────────────────────────────────────────────

class AdhocTestRequest(BaseModel):
    conn_type: str
    host: Optional[str] = None
    port: Optional[int] = None
    database: Optional[str] = None
    username: Optional[str] = None
    password: Optional[str] = None
    extra: Optional[dict] = None


@router.post("/test-adhoc")
async def test_connection_adhoc(body: AdhocTestRequest):
    """Test a connection using form values directly (no saved record needed)."""
    extra = body.extra or {}
    dialect = extra.get("dialect", "postgresql")
    driver  = extra.get("driver", "")
    scheme  = f"{dialect}+{driver}" if driver else dialect

    import urllib.parse
    url = f"{scheme}://"
    if body.username:
        url += body.username
        if body.password:
            url += f":{urllib.parse.quote_plus(body.password)}"
        url += "@"
    if body.host:
        url += body.host
        if body.port:
            url += f":{body.port}"
    if body.database:
        url += f"/{body.database}"

    result = await jdbc_service.test_connection_url(url)
    return result


# ─────────────────────────────────────────────────────────────────────────────
# Test connection (saved record)
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/{conn_id}/test")
async def test_connection(
    conn_id: int,
    db: AsyncSession = Depends(get_db),
):
    """Test whether a named connection is reachable."""
    conn = await db.get(Connection, conn_id)
    if not conn:
        raise HTTPException(status_code=404, detail="Connection not found")
    result = await jdbc_service.test_connection(conn)
    return result


# ─────────────────────────────────────────────────────────────────────────────
# SQL preview
# ─────────────────────────────────────────────────────────────────────────────

class SqlPreviewRequest(BaseModel):
    sql: str
    params: dict[str, str] = {}
    limit: int = 100


@router.post("/{conn_id}/preview-sql")
async def preview_sql(
    conn_id: int,
    body: SqlPreviewRequest,
    db: AsyncSession = Depends(get_db),
):
    """Execute SQL (with parameter injection) and return preview rows."""
    conn = await db.get(Connection, conn_id)
    if not conn:
        raise HTTPException(status_code=404, detail="Connection not found")

    # Validate: only SELECT statements allowed
    stripped = body.sql.strip().upper()
    if not stripped.startswith("SELECT") and not stripped.startswith("WITH"):
        raise HTTPException(status_code=400, detail="Only SELECT / WITH statements are allowed for preview")

    try:
        result = await jdbc_service.preview_sql(conn, body.sql, body.params, body.limit)
        return result
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


# ─────────────────────────────────────────────────────────────────────────────
# Extract to parquet
# ─────────────────────────────────────────────────────────────────────────────

class ExtractRequest(BaseModel):
    sql: str
    params: dict[str, str] = {}
    chunk_size: int = 50_000
    output_subdir: Optional[str] = None   # relative to PARQUET_DIR; auto-derived if omitted


class ExtractResponse(BaseModel):
    total_rows: int
    file_count: int
    output_dir: str
    files: list[str]


@router.post("/{conn_id}/extract", response_model=ExtractResponse)
async def extract_to_parquet(
    conn_id: int,
    body: ExtractRequest,
    db: AsyncSession = Depends(get_db),
):
    """Run an extraction query and write results to chunked parquet files."""
    conn = await db.get(Connection, conn_id)
    if not conn:
        raise HTTPException(status_code=404, detail="Connection not found")

    stripped = body.sql.strip().upper()
    if not stripped.startswith("SELECT") and not stripped.startswith("WITH"):
        raise HTTPException(status_code=400, detail="Only SELECT / WITH statements are allowed")

    # Derive output sub-directory
    if body.output_subdir:
        # Sanitise: only allow alphanumeric, underscore, hyphen, slash
        safe = re.sub(r"[^a-zA-Z0-9_\-/]", "_", body.output_subdir)
        output_dir = Path(settings.PARQUET_DIR) / safe
    else:
        ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        safe_name = re.sub(r"[^a-zA-Z0-9_]", "_", conn.name)
        output_dir = Path(settings.PARQUET_DIR) / f"{safe_name}_{ts}"

    try:
        result = await jdbc_service.extract_to_parquet(
            conn,
            body.sql,
            body.params,
            output_dir,
            body.chunk_size,
            conn.name,
        )
        return result
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


# ─────────────────────────────────────────────────────────────────────────────
# For-Each Extract — iterate over dictionary entries, one extract per row
# ─────────────────────────────────────────────────────────────────────────────

class ForeachEntryResult(BaseModel):
    key: str
    value: str
    total_rows: int
    file_count: int
    output_dir: str
    error: Optional[str] = None


class ForeachExtractRequest(BaseModel):
    sql: str
    dictionary_id: int
    key_param: str                      # SQL param name for the key column (e.g. "app_id")
    value_param: str                    # SQL param name for the value column (e.g. "app_name")
    static_params: dict[str, str] = {} # extra params shared across all iterations
    # Output path template — supports {key_param}, {value_param}, and any static_param key
    # e.g. "{business_date}/{pipeline_name}/{app_id}"
    output_path_template: str = "{app_id}"
    chunk_size: int = 50_000
    # Optional allowlist of entry keys to iterate over (empty / null = all entries)
    selected_keys: list[str] | None = None


@router.post("/{conn_id}/foreach-extract", response_model=list[ForeachEntryResult])
async def foreach_extract(
    conn_id: int,
    body: ForeachExtractRequest,
    db: AsyncSession = Depends(get_db),
):
    """Run extraction once per dictionary entry, injecting key/value as SQL params."""
    conn = await db.get(Connection, conn_id)
    if not conn:
        raise HTTPException(status_code=404, detail="Connection not found")

    # Load dictionary with entries
    result = await db.execute(
        select(Dictionary)
        .where(Dictionary.id == body.dictionary_id)
        .options(selectinload(Dictionary.entries))
    )
    dictionary = result.scalar_one_or_none()
    if not dictionary:
        raise HTTPException(status_code=404, detail="Dictionary not found")

    if not dictionary.entries:
        raise HTTPException(status_code=400, detail="Dictionary has no entries")

    stripped = body.sql.strip().upper()
    if not stripped.startswith("SELECT") and not stripped.startswith("WITH"):
        raise HTTPException(status_code=400, detail="Only SELECT / WITH statements are allowed")

    results: list[ForeachEntryResult] = []

    # Filter entries by selected_keys if provided
    entries_to_run = [
        e for e in dictionary.entries
        if not body.selected_keys or e.key in body.selected_keys
    ]

    for entry in entries_to_run:
        # Build params for this iteration
        params = {**body.static_params, body.key_param: entry.key, body.value_param: entry.value}

        # Resolve output path template
        template_vars = {**body.static_params, body.key_param: entry.key, body.value_param: entry.value}
        try:
            raw_path = body.output_path_template.format(**template_vars)
        except KeyError:
            raw_path = body.output_path_template
        safe_path = re.sub(r"[^a-zA-Z0-9_\-/]", "_", raw_path)
        output_dir = Path(settings.PARQUET_DIR) / safe_path

        try:
            stats = await jdbc_service.extract_to_parquet(
                conn, body.sql, params, output_dir, body.chunk_size, conn.name
            )
            results.append(ForeachEntryResult(
                key=entry.key,
                value=entry.value,
                total_rows=stats["total_rows"],
                file_count=stats["file_count"],
                output_dir=stats["output_dir"],
            ))
        except Exception as exc:
            results.append(ForeachEntryResult(
                key=entry.key,
                value=entry.value,
                total_rows=0,
                file_count=0,
                output_dir=str(output_dir),
                error=str(exc),
            ))

    return results


# ─────────────────────────────────────────────────────────────────────────────
# Datawarehouse — test
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/{conn_id}/test-dw")
async def test_dw_connection(
    conn_id: int,
    db: AsyncSession = Depends(get_db),
):
    """Test a datawarehouse-type connection using the bespoke library."""
    from app.services import datawarehouse_service

    conn = await db.get(Connection, conn_id)
    if not conn:
        raise HTTPException(status_code=404, detail="Connection not found")
    if conn.conn_type != "datawarehouse":
        raise HTTPException(status_code=400, detail="Connection is not of type 'datawarehouse'")

    config = datawarehouse_service.config_from_connection(conn)
    return await datawarehouse_service.test_connection(config)


# ─────────────────────────────────────────────────────────────────────────────
# Datawarehouse — streaming extract (SSE)
# ─────────────────────────────────────────────────────────────────────────────

class DWExtractRequest(BaseModel):
    sql:            str
    chunk_size:     int = 50_000
    output_subdir:  Optional[str] = None
    output_format:  str = "parquet"   # "parquet" | "csv"


@router.post("/{conn_id}/extract-dw")
async def extract_dw_stream(
    conn_id: int,
    body: DWExtractRequest,
    db: AsyncSession = Depends(get_db),
):
    """
    Stream a datawarehouse extraction as Server-Sent Events.

    Each SSE message carries a JSON payload with an 'event' field:
      connected | schema | chunk | done | error

    The client should consume this endpoint with EventSource or fetch+ReadableStream.
    """
    from fastapi.responses import StreamingResponse
    from app.services import datawarehouse_service

    conn = await db.get(Connection, conn_id)
    if not conn:
        raise HTTPException(status_code=404, detail="Connection not found")
    if conn.conn_type != "datawarehouse":
        raise HTTPException(status_code=400, detail="Connection is not of type 'datawarehouse'")

    stripped = body.sql.strip().upper()
    if not stripped.startswith("SELECT") and not stripped.startswith("WITH"):
        raise HTTPException(status_code=400, detail="Only SELECT / WITH statements are allowed")

    # Resolve output directory
    if body.output_subdir:
        safe = re.sub(r"[^a-zA-Z0-9_\-/]", "_", body.output_subdir)
        output_dir = Path(settings.PARQUET_DIR) / safe
    else:
        ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        safe_name = re.sub(r"[^a-zA-Z0-9_]", "_", conn.name)
        output_dir = Path(settings.PARQUET_DIR) / f"{safe_name}_{ts}"

    try:
        fmt = datawarehouse_service.OutputFormat(body.output_format)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid output_format '{body.output_format}'. Use 'parquet' or 'csv'.")

    config = datawarehouse_service.config_from_connection(conn)

    async def event_stream():
        import json
        # Emit a "connected" heartbeat immediately so the client knows the stream opened
        yield f"data: {json.dumps({'event': 'connected', 'message': f'Starting extract for connection {conn.name}'})}\n\n"
        async for line in datawarehouse_service.extract_stream_async(
            config, body.sql, output_dir, body.chunk_size, fmt
        ):
            yield line

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",   # disable nginx buffering if present
        },
    )


# ─────────────────────────────────────────────────────────────────────────────
# S3 — test connection
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/{conn_id}/test-s3")
async def test_s3_connection(
    conn_id: int,
    db: AsyncSession = Depends(get_db),
):
    """Test an S3-type connection (list-objects ping)."""
    from app.services import s3_service

    conn = await db.get(Connection, conn_id)
    if not conn:
        raise HTTPException(status_code=404, detail="Connection not found")
    if conn.conn_type != "s3":
        raise HTTPException(status_code=400, detail="Connection is not of type 's3'")

    config = s3_service.config_from_connection(conn)
    return await s3_service.test_connection(config)


# ─────────────────────────────────────────────────────────────────────────────
# S3 — list matching files
# ─────────────────────────────────────────────────────────────────────────────

class S3ListRequest(BaseModel):
    prefix:   str = ""
    pattern:  str = "*"
    max_keys: int = 1000


@router.post("/{conn_id}/s3-list")
async def s3_list_files(
    conn_id: int,
    body: S3ListRequest,
    db: AsyncSession = Depends(get_db),
):
    """List S3 objects matching prefix + pattern. Returns at most max_keys keys."""
    from app.services import s3_service

    conn = await db.get(Connection, conn_id)
    if not conn:
        raise HTTPException(status_code=404, detail="Connection not found")
    if conn.conn_type != "s3":
        raise HTTPException(status_code=400, detail="Connection is not of type 's3'")

    config = s3_service.config_from_connection(conn)
    keys = await s3_service.list_files(config, body.prefix, body.pattern, body.max_keys)
    return {"count": len(keys), "keys": keys}


# ─────────────────────────────────────────────────────────────────────────────
# S3 — ingest to Spark (SSE streaming)
# ─────────────────────────────────────────────────────────────────────────────

class S3IngestRequest(BaseModel):
    # Source
    prefix:          str
    pattern:         str        = "*"
    format:          str        = "auto"    # auto | parquet | csv | json | orc
    # CSV reader options
    csv_header:      bool       = True
    csv_sep:         str        = ","
    csv_infer:       bool       = True
    # Extra Spark reader options (e.g. {"multiLine": "true"} for JSON)
    reader_options:  dict[str, str] = {}
    # Transformation (optional) — SQL referencing {source} as the input view name
    transform_sql:   Optional[str] = None
    # Target Spark table
    target_db:       str        = "default"
    target_table:    str
    write_mode:      str        = "overwrite"  # overwrite | append | ignore | error


@router.post("/{conn_id}/s3-ingest")
async def s3_ingest_stream(
    conn_id: int,
    body: S3IngestRequest,
    db: AsyncSession = Depends(get_db),
):
    """
    Ingest files from S3 into a Spark table, streaming progress as SSE.

    Events: listing → matched → download(×N) → reading → schema → transform? → saving → done | error
    """
    from fastapi.responses import StreamingResponse
    from app.services import s3_service

    conn = await db.get(Connection, conn_id)
    if not conn:
        raise HTTPException(status_code=404, detail="Connection not found")
    if conn.conn_type != "s3":
        raise HTTPException(status_code=400, detail="Connection is not of type 's3'")

    if not body.target_table:
        raise HTTPException(status_code=400, detail="target_table is required")

    # Validate target names (alphanumeric + underscore only)
    if not re.match(r"^[a-zA-Z0-9_]+$", body.target_table):
        raise HTTPException(status_code=400, detail="target_table must be alphanumeric/underscore only")
    if not re.match(r"^[a-zA-Z0-9_]+$", body.target_db):
        raise HTTPException(status_code=400, detail="target_db must be alphanumeric/underscore only")

    try:
        fmt        = s3_service.S3Format(body.format)
        write_mode = s3_service.WriteMode(body.write_mode)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    config = s3_service.config_from_connection(conn)

    async def event_stream():
        import json
        yield f"data: {json.dumps({'event': 'connected', 'message': f'Starting S3 ingest from s3://{config.bucket}/{body.prefix}'})}\n\n"
        async for line in s3_service.ingest_stream_async(
            config       = config,
            prefix       = body.prefix,
            pattern      = body.pattern,
            fmt          = fmt,
            transform_sql = body.transform_sql,
            target_db    = body.target_db,
            target_table = body.target_table,
            write_mode   = write_mode,
            csv_header   = body.csv_header,
            csv_sep      = body.csv_sep,
            csv_infer    = body.csv_infer,
            reader_options = body.reader_options or {},
        ):
            yield line

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )

