"""
JDBC Extract Service

Handles:
- Connection testing
- SQL preview with parameter injection
- Full extraction to chunked parquet files
"""
from __future__ import annotations

import asyncio
import logging
from datetime import date as _date, datetime, timezone
from pathlib import Path
from typing import Any, Optional

from app.core.config import settings
from app.services.crypto import decrypt_password

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# URL / connection helpers
# ─────────────────────────────────────────────────────────────────────────────

def build_sqlalchemy_url(conn) -> str:
    """Build a SQLAlchemy connection URL from a Connection model instance."""
    extra = conn.extra or {}
    # 1) pre-built URL stored in extra
    if "url" in extra:
        return str(extra["url"])
    # 2) assemble from fields
    dialect = extra.get("dialect", "postgresql")
    driver  = extra.get("driver", "")
    scheme  = f"{dialect}+{driver}" if driver else dialect
    password = decrypt_password(conn.password_encrypted) if conn.password_encrypted else None

    url = f"{scheme}://"
    if conn.username:
        url += conn.username
        if password:
            import urllib.parse
            url += f":{urllib.parse.quote_plus(password)}"
        url += "@"
    if conn.host:
        url += conn.host
        if conn.port:
            url += f":{conn.port}"
    if conn.database:
        url += f"/{conn.database}"
    return url


# ─────────────────────────────────────────────────────────────────────────────
# SQL parameter injection
# ─────────────────────────────────────────────────────────────────────────────

def inject_parameters(
    sql: str,
    params: dict[str, str],
) -> str:
    """Replace $param_name placeholders in SQL with their resolved values.
    Longer keys are replaced first to avoid prefix collisions."""
    result = sql
    for key, value in sorted(params.items(), key=lambda kv: -len(kv[0])):
        placeholder = f"${key}" if not key.startswith("$") else key
        result = result.replace(placeholder, str(value))
    return result


# ─────────────────────────────────────────────────────────────────────────────
# Sync helpers (run in thread pool)
# ─────────────────────────────────────────────────────────────────────────────

def _test_connection_sync(url: str) -> dict:
    """Synchronously test a connection. Returns {ok, latency_ms, message}."""
    import time
    from sqlalchemy import create_engine, text

    t0 = time.perf_counter()
    try:
        engine = create_engine(url, future=True, pool_pre_ping=True)
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        engine.dispose()
        latency_ms = round((time.perf_counter() - t0) * 1000, 1)
        return {"ok": True, "latency_ms": latency_ms, "message": "Connection successful"}
    except Exception as exc:
        latency_ms = round((time.perf_counter() - t0) * 1000, 1)
        return {"ok": False, "latency_ms": latency_ms, "message": str(exc)}


def _preview_sql_sync(
    url: str,
    sql: str,
    params: dict[str, str],
    limit: int = 100,
) -> dict:
    """Execute SQL with parameters, returning column names + rows."""
    import re
    import pandas as pd
    from sqlalchemy import create_engine, text

    resolved_sql = inject_parameters(sql, params)

    # Append LIMIT only if the SQL doesn't already have one
    stripped = resolved_sql.rstrip('; \t\n')
    has_limit = bool(re.search(r'\bLIMIT\s+\d+', stripped, re.IGNORECASE))
    safe_sql = stripped if has_limit else f"{stripped} LIMIT {limit}"

    engine = create_engine(url, future=True)
    try:
        with engine.connect() as conn:
            df = pd.read_sql(text(safe_sql), conn)
    finally:
        engine.dispose()

    columns = list(df.columns)
    rows = []
    for _, row in df.iterrows():
        rows.append([None if (hasattr(v, '__class__') and str(type(v)) == "<class 'float'>" and str(v) == 'nan') else
                     (v.isoformat() if hasattr(v, 'isoformat') else v)
                     for v in row.tolist()])

    return {
        "columns": columns,
        "rows": rows,
        "row_count": len(rows),
        "resolved_sql": resolved_sql,
    }


def schema_to_dict(schema: Any) -> list[dict]:
    """Convert a pyarrow Schema to a JSON-serialisable list of field descriptors."""
    return [
        {"name": field.name, "type": str(field.type), "nullable": field.nullable}
        for field in schema
    ]


def _write_chunk_pyarrow_sync(
    records: list[dict],
    output_path: Path,
    schema: Any = None,
) -> tuple[Any, str]:
    """Write a list of records to parquet using pyarrow with optional schema enforcement.

    On the first call pass schema=None — the schema is inferred from the data and returned.
    On subsequent calls pass the schema from the first call to cast all chunks to the same
    column types, enforcing a strict, consistent schema across all output files.

    Returns (pa.Schema, file_path_str).
    """
    import pandas as pd  # type: ignore
    import pyarrow as pa  # type: ignore
    import pyarrow.parquet as pq  # type: ignore

    df = pd.DataFrame(records) if records else pd.DataFrame()
    table = pa.Table.from_pandas(df, preserve_index=False)

    if schema is None:
        # Infer schema from this first chunk
        schema = table.schema
    else:
        # Cast to the reference schema for strict enforcement
        try:
            table = table.cast(schema)
        except (pa.ArrowInvalid, pa.ArrowNotImplementedError) as exc:
            logger.warning(
                "Chunk schema cast skipped (%s) — writing with inferred schema",
                exc,
            )
            schema = table.schema  # allow inferred schema if cast impossible

    output_path.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(table, str(output_path))
    logger.info("Wrote %s (%d rows, pyarrow)", output_path.name, len(df))
    return schema, str(output_path)


def _extract_to_parquet_sync(
    url: str,
    sql: str,
    params: dict[str, str],
    output_dir: Path,
    chunk_size: int = 50_000,
    job_name: str = "extract",
) -> dict:
    """Stream SQL results into chunked parquet files using strict pyarrow schema. Returns stats."""
    import json
    import pyarrow as pa  # type: ignore

    resolved_sql = inject_parameters(sql, params)
    output_dir.mkdir(parents=True, exist_ok=True)

    engine_url = url  # already a SQLAlchemy URL string
    from sqlalchemy import create_engine, text  # type: ignore
    import pandas as pd  # type: ignore

    engine = create_engine(engine_url, future=True)
    total_rows = 0
    file_count = 0
    files_written: list[str] = []
    inferred_schema: Any = None

    try:
        with engine.connect() as conn:
            chunk_iter = pd.read_sql(
                text(resolved_sql),
                conn,
                chunksize=chunk_size,
            )
            for chunk in chunk_iter:
                if chunk.empty:
                    continue
                fname = output_dir / f"part_{file_count:05d}.parquet"
                inferred_schema, path = _write_chunk_pyarrow_sync(
                    chunk.to_dict(orient="records"),
                    fname,
                    inferred_schema,
                )
                total_rows += len(chunk)
                file_count += 1
                files_written.append(path)
    finally:
        engine.dispose()

    schema_list: list[dict] = []
    if inferred_schema is not None:
        schema_list = schema_to_dict(inferred_schema)
        schema_path = output_dir / "schema.json"
        schema_path.write_text(
            __import__("json").dumps(schema_list, indent=2),
            encoding="utf-8",
        )
        logger.info("Schema written to %s (%d fields)", schema_path, len(schema_list))

    return {
        "total_rows": total_rows,
        "file_count": file_count,
        "files": files_written,
        "output_dir": str(output_dir),
        "schema": schema_list,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Async public interface
# ─────────────────────────────────────────────────────────────────────────────

async def test_connection_url(url: str) -> dict:
    """Test a connection given a raw SQLAlchemy URL string."""
    return await asyncio.to_thread(_test_connection_sync, url)


async def test_connection(conn) -> dict:
    url = build_sqlalchemy_url(conn)
    return await asyncio.to_thread(_test_connection_sync, url)


async def preview_sql(
    conn,
    sql: str,
    params: dict[str, str],
    limit: int = 100,
) -> dict:
    url = build_sqlalchemy_url(conn)
    return await asyncio.to_thread(_preview_sql_sync, url, sql, params, limit)


async def extract_to_parquet(
    conn,
    sql: str,
    params: dict[str, str],
    output_dir: Path,
    chunk_size: int = 50_000,
    job_name: str = "extract",
) -> dict:
    url = build_sqlalchemy_url(conn)
    return await asyncio.to_thread(
        _extract_to_parquet_sync, url, sql, params, output_dir, chunk_size, job_name
    )
