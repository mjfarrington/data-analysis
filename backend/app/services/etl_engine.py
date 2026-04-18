"""
ETL Execution Engine — orchestrates Extract, Transform, Load pipelines.
Supports sources: gRPC, JDBC (SQLAlchemy), JSON, CSV.
Runs asynchronously and emits log events via an asyncio queue.
"""
from __future__ import annotations

import asyncio
import logging
import traceback
from datetime import date as _date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, AsyncIterator, Optional

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.etl import ETLRun, ETLRunLog, ExtractJob, RunStatus, RunStep, StepType, ServiceError
from app.schemas.etl import ExtractConfig, TransformConfig, LoadConfig
from app.services.grpc_client import grpc_client
from app.services.spark_service import spark_service

logger = logging.getLogger(__name__)

# Global broadcast queue: (run_id, log_entry_dict) for WebSocket consumers
_log_broadcast: asyncio.Queue = asyncio.Queue(maxsize=1000)
_active_runs: dict[int, asyncio.Task] = {}


def get_broadcast_queue() -> asyncio.Queue:
    return _log_broadcast


def get_active_run_ids() -> list[int]:
    return list(_active_runs.keys())


async def _push_log(
    db: AsyncSession,
    run_id: int,
    message: str,
    level: str = "INFO",
    step: Optional[str] = None,
    extra: Optional[dict] = None,
) -> None:
    entry = ETLRunLog(
        run_id=run_id,
        level=level,
        message=message,
        step=step,
        extra=extra,
    )
    db.add(entry)
    await db.flush()
    log_dict = {
        "run_id": run_id,
        "id": entry.id,
        "level": level,
        "message": message,
        "step": step,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "extra": extra,
    }
    try:
        _log_broadcast.put_nowait(log_dict)
    except asyncio.QueueFull:
        pass  # Drop if no one is listening


# ─────────────────────────────────────────────────────────────────────────────
# Transform
# ─────────────────────────────────────────────────────────────────────────────
def _apply_transforms(records: list[dict], cfg: TransformConfig) -> list[dict]:
    if not records:
        return records

    # Drop columns
    if cfg.drop_columns:
        records = [
            {k: v for k, v in r.items() if k not in cfg.drop_columns}
            for r in records
        ]

    # Rename columns
    if cfg.rename_columns:
        records = [
            {cfg.rename_columns.get(k, k): v for k, v in r.items()}
            for r in records
        ]

    # Apply filters (simple equality)
    for col, val in cfg.filters.items():
        records = [r for r in records if str(r.get(col, "")) == str(val)]

    # Deduplication — only if at least one dedup key column is actually present in the data
    if cfg.dedup and cfg.dedup_keys and records:
        present_keys = [k for k in cfg.dedup_keys if k in records[0]]
        if present_keys:
            seen: set = set()
            deduped: list[dict] = []
            for r in records:
                key = tuple(r.get(k) for k in present_keys)
                if key not in seen:
                    seen.add(key)
                    deduped.append(r)
            records = deduped

    return records


# ─────────────────────────────────────────────────────────────────────────────
# SQL variable injection
# ─────────────────────────────────────────────────────────────────────────────

_DATE_FORMATS: dict[str, str] = {
    "YYYYMMDD": "%Y%m%d",
    "YYYY-MM-DD": "%Y-%m-%d",
    "YYYYMM": "%Y%m",
    "YYYY/MM/DD": "%Y/%m/%d",
    "DD/MM/YYYY": "%d/%m/%Y",
    "MM/DD/YYYY": "%m/%d/%Y",
}


def _fmt_date(d: _date, fmt: str) -> str:
    return d.strftime(_DATE_FORMATS.get(fmt, "%Y%m%d"))


def inject_sql_vars(
    sql: str,
    business_date_iso: Optional[str],
    date_var_format: str = "YYYYMMDD",
    date_range_mode: str = "single",
    date_range_from_iso: Optional[str] = None,
    date_range_to_iso: Optional[str] = None,
    app_id: Optional[str] = None,
    app_name: Optional[str] = None,
) -> tuple[str, dict[str, str]]:
    """Replace $business_date*, $app_id and $app_name placeholders in *sql*.

    Returns (resolved_sql, variables) where *variables* maps each placeholder
    to the value that was (or would be) substituted.

    Supported placeholders:
        $business_date          – the business date (single mode) or range start
        $business_date_from     – start of the resolved date range
        $business_date_to       – end of the resolved date range
        $business_date_range    – BETWEEN <from> AND <to>
        $app_id                 – the application ID
        $app_name               – the application name
    """
    variables: dict[str, str] = {}

    if app_id:
        variables["$app_id"] = app_id
    if app_name:
        variables["$app_name"] = app_name

    if business_date_iso:
        base = _date.fromisoformat(business_date_iso)

        if date_range_mode == "current_month":
            d_from = base.replace(day=1)
            d_to = (d_from.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
        elif date_range_mode == "previous_month":
            first_this = base.replace(day=1)
            d_to = first_this - timedelta(days=1)
            d_from = d_to.replace(day=1)
        elif date_range_mode == "custom" and date_range_from_iso and date_range_to_iso:
            d_from = _date.fromisoformat(date_range_from_iso)
            d_to = _date.fromisoformat(date_range_to_iso)
        else:  # single
            d_from = base
            d_to = base

        fmt_base = _fmt_date(base, date_var_format)
        fmt_from = _fmt_date(d_from, date_var_format)
        fmt_to = _fmt_date(d_to, date_var_format)

        variables.update({
            "$business_date": fmt_base,
            "$business_date_from": fmt_from,
            "$business_date_to": fmt_to,
            "$business_date_range": f"BETWEEN {fmt_from} AND {fmt_to}",
        })

    if not variables:
        return sql, {}

    result = sql
    # Replace longer placeholders first so that a shared prefix (e.g. the
    # 14-char "$business_date") does not corrupt longer siblings such as
    # "$business_date_from" before they get a chance to be substituted.
    for placeholder, value in sorted(variables.items(), key=lambda kv: -len(kv[0])):
        result = result.replace(placeholder, value)

    return result, variables


# ─────────────────────────────────────────────────────────────────────────────
# Source handlers
# ─────────────────────────────────────────────────────────────────────────────

async def _extract_grpc(
    cfg: ExtractConfig,
    app_id: str,
    date_str: str,
    log_fn,
) -> AsyncIterator[tuple[list[dict], int, int]]:
    """Yields (records, segment_index, total_segments) from the gRPC service."""
    probe = await grpc_client.extract_segment(app_id, date_str, 0, cfg.page_size)
    total_segments: int = probe.get("total_segments", 1)
    await log_fn(
        f"  gRPC: {total_segments} server-side segments, "
        f"~{probe.get('total_records', '?')} total records",
        step="extract",
    )
    for seg in range(total_segments):
        chunk = probe if seg == 0 else await grpc_client.extract_segment(
            app_id, date_str, seg, cfg.page_size
        )
        yield chunk.get("records", []), seg, total_segments


async def _resolve_sql(
    cfg: ExtractConfig,
    db: AsyncSession,
    business_date: Optional[str] = None,
    app_id: Optional[str] = None,
    app_name: Optional[str] = None,
) -> str:
    """Return the SQL string from inline text or referenced SqlFile, with
    $business_date*, $app_id and $app_name placeholders substituted."""
    if cfg.jdbc_sql:
        raw = cfg.jdbc_sql.strip()
    elif cfg.jdbc_sql_file_id:
        from app.models.etl import SqlFile
        sql_file = await db.get(SqlFile, cfg.jdbc_sql_file_id)
        if not sql_file:
            raise ValueError(f"SqlFile id={cfg.jdbc_sql_file_id} not found")
        raw = sql_file.content.strip()
    elif cfg.jdbc_table:
        return f"SELECT * FROM {cfg.jdbc_table}"
    else:
        raise ValueError(
            "JDBC source requires one of: jdbc_sql, jdbc_sql_file_id, or jdbc_table"
        )

    if business_date or app_id or app_name:
        resolved, _ = inject_sql_vars(
            raw,
            business_date,
            date_var_format=cfg.jdbc_date_var_format or "YYYYMMDD",
            date_range_mode=cfg.jdbc_date_range_mode or "single",
            date_range_from_iso=cfg.jdbc_date_range_from,
            date_range_to_iso=cfg.jdbc_date_range_to,
            app_id=app_id,
            app_name=app_name,
        )
        return resolved
    return raw


def _read_jdbc_sync(
    jdbc_url: str,
    sql: str,
    date_column: Optional[str],
    date_str: Optional[str],
) -> list[dict]:
    """Synchronous JDBC read via SQLAlchemy + pandas (runs in thread pool)."""
    import pandas as pd
    from sqlalchemy import create_engine, text

    engine = create_engine(jdbc_url, future=True)
    query = sql
    params: dict = {}

    if date_column and date_str:
        stripped = query.rstrip().rstrip(";")
        query = (
            f"SELECT * FROM ({stripped}) AS _etl_src "
            f"WHERE {date_column} = :biz_date"
        )
        params["biz_date"] = date_str

    with engine.connect() as conn:
        df = pd.read_sql(text(query), conn, params=params)
    engine.dispose()
    return df.to_dict(orient="records")


async def _resolve_jdbc_url(cfg: ExtractConfig, db: AsyncSession) -> str:
    """Return the SQLAlchemy JDBC URL for the extract config.

    Priority:
      1. Named connection (jdbc_connection_id) — URL assembled server-side (password never sent to UI).
      2. Inline jdbc_url — used as-is.
    """
    if cfg.jdbc_connection_id:
        from app.models.etl import Connection
        from app.services.crypto import decrypt_password
        conn = await db.get(Connection, cfg.jdbc_connection_id)
        if not conn:
            raise ValueError(f"Connection ID {cfg.jdbc_connection_id} not found")
        extra = conn.extra or {}
        # Prefer a pre-built URL stored in extra (e.g. extra={"url": "postgresql://..."})
        if "url" in extra:
            return str(extra["url"])
        # Assemble from structured fields
        dialect = extra.get("dialect", "postgresql")
        password = decrypt_password(conn.password_encrypted) if conn.password_encrypted else None
        url = f"{dialect}://"
        if conn.username:
            url += conn.username
            if password:
                url += f":{password}"
            url += "@"
        if conn.host:
            url += conn.host
            if conn.port:
                url += f":{conn.port}"
        if conn.database:
            url += f"/{conn.database}"
        return url
    elif cfg.jdbc_url:
        return cfg.jdbc_url
    else:
        raise ValueError("No JDBC connection configured — set a named connection or provide a JDBC URL.")


async def _extract_jdbc(
    cfg: ExtractConfig,
    date_str: Optional[str],
    log_fn,
    db: AsyncSession,
    business_date: Optional[str] = None,
    app_id: Optional[str] = None,
) -> list[dict]:
    jdbc_url = await _resolve_jdbc_url(cfg, db)
    sql = await _resolve_sql(cfg, db, business_date=business_date, app_id=app_id)
    await log_fn(
        f"  JDBC: {jdbc_url!r} — SQL {len(sql)} chars"
        + (f" filtered on {cfg.jdbc_date_column}={date_str!r}" if cfg.jdbc_date_column and date_str else "")
        + (f" app_id={app_id!r}" if app_id else ""),
        step="extract",
    )
    return await asyncio.to_thread(
        _read_jdbc_sync,
        jdbc_url,
        sql,
        cfg.jdbc_date_column,
        date_str,
    )


async def _extract_datawarehouse(
    cfg: ExtractConfig,
    date_str: Optional[str],
    log_fn,
    db: AsyncSession,
    business_date: Optional[str] = None,
    app_id: Optional[str] = None,
    app_name: Optional[str] = None,
    rows_per_segment: int = 100_000,
) -> tuple[list[dict], float]:
    """Extract records from a DataWarehouse connection (Impala or Spark).

    Returns (records, segment_delay_s) where segment_delay_s is an optional
    per-segment sleep injected by the DUMMY datasource for testing.
    """
    if not cfg.dw_connection_id:
        raise ValueError("DataWarehouse source requires a named connection (dw_connection_id).")
    from app.models.etl import Connection as ConnModel
    from app.services.crypto import decrypt_password

    conn = await db.get(ConnModel, cfg.dw_connection_id)
    if not conn:
        raise ValueError(f"DataWarehouse connection ID {cfg.dw_connection_id} not found.")
    extra = conn.extra or {}
    datasource = str(extra.get("datasource", "IMPALA")).upper()
    timeout_ms = int(extra.get("timeout", 30000))
    uppercase_columns = bool(extra.get("uppercase_columns", False))
    extra_params = dict(extra.get("params", {}))
    segment_delay_s = float(extra_params.get("dummy_segment_delay", 0.0)) if datasource == "DUMMY" else 0.0
    password = decrypt_password(conn.password_encrypted) if conn.password_encrypted else None

    sql = await _resolve_sql(cfg, db, business_date=business_date, app_id=app_id, app_name=app_name)
    await log_fn(
        f"  DataWarehouse ({datasource}) env={extra.get('environment', '?')} "
        f"user={conn.username!r} — SQL {len(sql)} chars"
        + (f" [segment_delay={segment_delay_s}s]" if segment_delay_s else ""),
        step="extract",
    )
    records = await asyncio.to_thread(
        _read_dw_sync,
        conn.host,
        conn.port,
        conn.username,
        password,
        datasource,
        timeout_ms,
        uppercase_columns,
        extra_params,
        sql,
        rows_per_segment,
    )
    return records, segment_delay_s


def _read_dw_sync(
    host: Optional[str],
    port: Optional[int],
    username: Optional[str],
    password: Optional[str],
    datasource: str,
    timeout_ms: int,
    uppercase_columns: bool,
    extra_params: dict,
    sql: str,
    rows_per_segment: int = 100_000,
) -> list[dict]:
    """Synchronous DataWarehouse query (runs in a thread pool)."""
    import pandas as pd

    timeout_s = max(1, timeout_ms // 1000) if timeout_ms else 30

    if datasource == "IMPALA":
        from impala.dbapi import connect  # type: ignore[import]
        cx = connect(
            host=host or "",
            port=port or 21050,
            user=username,
            password=password,
            timeout=timeout_s,
            **extra_params,
        )
        df = pd.read_sql(sql, cx)
        cx.close()
    elif datasource == "SPARK":
        from pyspark.sql import SparkSession  # type: ignore[import]
        spark = SparkSession.builder.getOrCreate()
        df = spark.sql(sql).toPandas()
    elif datasource == "DUMMY":
        import hashlib as _hashlib
        import random as _random
        import datetime as _dt
        import re as _re

        num_segs = int(extra_params.get("dummy_num_segments", 0))
        row_count = (
            num_segs * rows_per_segment
            if num_segs > 0
            else int(extra_params.get("dummy_row_count", 500_000))
        )

        # Parse column specs from SELECT ... FROM.
        # Each entry is (col_name, fixed_value_or_None).  A fixed value is set
        # when the SELECT expression is a literal (e.g. injected $business_date
        # becomes 20260416) so those columns keep the injected value instead of
        # having fake data generated for them.
        col_specs: list[tuple[str, object]] = []
        select_match = _re.search(r'\bSELECT\b(.*?)\bFROM\b', sql, _re.IGNORECASE | _re.DOTALL)
        if select_match:
            select_body = select_match.group(1).strip()
            if select_body.strip() == '*':
                col_specs = [(f"col_{i}", None) for i in range(1, 6)]
            else:
                for part in _re.split(r',(?![^()]*\))', select_body):
                    part = part.strip()
                    alias_m = _re.search(r'\bAS\s+`?(\w+)`?\s*$', part, _re.IGNORECASE)
                    expr = part[:alias_m.start()].strip() if alias_m else part
                    col_name = alias_m.group(1) if alias_m else None

                    # Detect literal values produced by $variable injection
                    fixed_value: object = None
                    quoted_m = _re.fullmatch(r"""['"](.*?)['"]""", expr)
                    if quoted_m:
                        fixed_value = quoted_m.group(1)
                    elif _re.fullmatch(r'\d{4}-\d{2}-\d{2}', expr):   # YYYY-MM-DD
                        fixed_value = expr
                    elif _re.fullmatch(r'\d{4}/\d{2}/\d{2}', expr):   # YYYY/MM/DD
                        fixed_value = expr
                    elif _re.fullmatch(r'\d{2}/\d{2}/\d{4}', expr):   # DD/MM/YYYY or MM/DD/YYYY
                        fixed_value = expr
                    elif _re.fullmatch(r'\d{6,8}', expr):              # YYYYMMDD / YYYYMM
                        fixed_value = expr
                    elif _re.fullmatch(r'-?\d+\.\d+', expr):
                        fixed_value = float(expr)
                    elif _re.fullmatch(r'-?\d+', expr):
                        fixed_value = int(expr)

                    if not col_name:
                        bare = _re.sub(r'\(.*?\)', '', part).strip()
                        word = _re.split(r'[\s.]+', bare)[-1].strip('`"\'') if bare else ''
                        col_name = word if word else None

                    if col_name:
                        col_specs.append((col_name, fixed_value))

        if not col_specs:
            col_specs = [(f"col_{i}", None) for i in range(1, 6)]

        columns = [c for c, _ in col_specs]

        # Deterministic RNG seeded from the SQL text so re-runs are consistent
        seed = int(_hashlib.md5(sql.encode()).hexdigest(), 16) % (2 ** 31)
        rng = _random.Random(seed)

        _STATUSES = ["ACTIVE", "INACTIVE", "PENDING", "CLOSED", "PROCESSING"]
        _NAMES = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta", "Theta"]
        _REGIONS = ["NORTH", "SOUTH", "EAST", "WEST", "CENTRAL"]
        _CURRENCIES = ["GBP", "USD", "EUR", "JPY"]

        def _fake(col: str, row_idx: int) -> object:
            n = col.lower()
            if _re.search(r'(^id$|_id$|_key$|_ref$)', n):
                return row_idx + 1
            if _re.search(r'(date|_dt$)', n):
                base = _dt.date(2026, 1, 1)
                return str(base.replace(month=rng.randint(1, 12), day=rng.randint(1, 28)))
            if _re.search(r'(name|desc|label|title|category)', n):
                return rng.choice(_NAMES)
            if _re.search(r'(amount|value|price|rate|total|sum|balance)', n):
                return round(rng.uniform(10.0, 10000.0), 2)
            if _re.search(r'(status|state|type|flag)', n):
                return rng.choice(_STATUSES)
            if _re.search(r'(region|area|zone)', n):
                return rng.choice(_REGIONS)
            if _re.search(r'(currency|ccy)', n):
                return rng.choice(_CURRENCIES)
            if _re.search(r'(count|num|qty|quantity|segment)', n):
                return rng.randint(1, 999)
            if _re.search(r'(is_|has_|active|enabled)', n):
                return rng.randint(0, 1)
            return f"VAL_{rng.randint(1000, 9999)}"

        records = [
            {col: (fixed if fixed is not None else _fake(col, i)) for col, fixed in col_specs}
            for i in range(row_count)
        ]
        df = pd.DataFrame(records)
    else:
        raise ValueError(f"Unsupported DataWarehouse datasource: {datasource!r}")

    if uppercase_columns:
        df.columns = [c.upper() for c in df.columns]  # type: ignore[assignment]
    return df.to_dict(orient="records")


def _read_file_sync(
    source_type: str,
    file_path: str,
    encoding: str,
    csv_delimiter: str,
    csv_has_header: bool,
    json_lines: bool,
) -> list[dict]:
    """Synchronous file read (runs in thread pool)."""
    import pandas as pd

    path = Path(settings.SOURCES_DIR) / file_path
    if not path.exists():
        raise FileNotFoundError(f"Source file not found: {path}")

    if source_type == "csv":
        header: Any = 0 if csv_has_header else None
        df = pd.read_csv(path, delimiter=csv_delimiter, header=header, encoding=encoding)
        return df.to_dict(orient="records")

    if source_type == "json":
        df = pd.read_json(path, lines=json_lines, encoding=encoding)
        return df.to_dict(orient="records")

    raise ValueError(f"Unsupported file source type: {source_type}")


async def _extract_file(cfg: ExtractConfig, log_fn) -> list[dict]:
    if not cfg.file_path:
        raise ValueError(f"{cfg.source_type.upper()} source requires file_path")
    await log_fn(
        f"  File ({cfg.source_type.upper()}): {cfg.file_path!r}",
        step="extract",
    )
    return await asyncio.to_thread(
        _read_file_sync,
        cfg.source_type,
        cfg.file_path,
        cfg.file_encoding,
        cfg.csv_delimiter,
        cfg.csv_has_header,
        cfg.json_lines,
    )


def _chunk_records(records: list[dict], chunk_size: int) -> list[list[dict]]:
    if not records:
        return []
    return [records[i : i + chunk_size] for i in range(0, len(records), chunk_size)]


# ─────────────────────────────────────────────────────────────────────────────
# Date list helper
# ─────────────────────────────────────────────────────────────────────────────
def _resolve_dates(cfg: ExtractConfig, business_date: Optional[str] = None) -> list[str]:
    dates: list[str] = list(cfg.dates or [])
    if not dates and cfg.date_from and cfg.date_to:
        from datetime import date, timedelta as td
        d = date.fromisoformat(cfg.date_from)
        end = date.fromisoformat(cfg.date_to)
        while d <= end:
            dates.append(d.isoformat())
            d += td(days=1)
    if not dates:
        # Prefer the business_date from execution context; fall back to today
        dates = [business_date or datetime.now(timezone.utc).strftime("%Y-%m-%d")]
    return dates


# ─────────────────────────────────────────────────────────────────────────────
# Load helper
# ─────────────────────────────────────────────────────────────────────────────
async def _load_segment(
    records: list[dict],
    app_id: str,
    date_str: str,
    seg_index: int,
    load_cfg: LoadConfig,
    log_fn,
    job_name: str = "PIPELINE",
) -> str:
    fmt = load_cfg.target if load_cfg.target in ("parquet", "csv") else "parquet"
    try:
        if fmt == "parquet":
            return await spark_service.save_records_parquet(
                records, app_id, date_str, seg_index, mode=load_cfg.mode, job_name=job_name
            )
        return await spark_service.save_records_csv(records, app_id, date_str, seg_index, job_name=job_name)
    except Exception as spark_err:
        await log_fn(f"  Write failed ({spark_err}), falling back to CSV", level="WARN")
        return await spark_service.save_records_csv(records, app_id, date_str, seg_index, job_name=job_name)
# ─────────────────────────────────────────────────────────────────────────────
# Core runner
# ─────────────────────────────────────────────────────────────────────────────
async def execute_pipeline(
    db: AsyncSession,
    run: ETLRun,
    extract_cfg: ExtractConfig,
    transform_cfg: TransformConfig,
    load_cfg: LoadConfig,
    business_date: Optional[str] = None,
) -> None:
    """Execute one ETL run. Updates run + extract_job rows in DB."""
    run_id = run.id
    _active_runs[run_id] = asyncio.current_task()  # type: ignore

    async def log(
        msg: str,
        level: str = "INFO",
        step: str | None = None,
        extra: dict | None = None,
    ):
        logger.log(getattr(logging, level, logging.INFO), "[run=%d] %s", run_id, msg)
        await _push_log(db, run_id, msg, level=level, step=step, extra=extra)
        await db.commit()

    try:
        run.status = RunStatus.RUNNING
        run.started_at = datetime.now(timezone.utc)
        await db.commit()
        await log("Pipeline started", step="init")
        await log(f"Source: {extract_cfg.source_type.upper()}", step="init")

        # ── Initialise per-step run tracking rows ─────────────────────────────
        step_rows: dict[StepType, RunStep] = {}
        for order, stype in enumerate([StepType.EXTRACT, StepType.TRANSFORM, StepType.LOAD]):
            rs = RunStep(
                run_id=run_id,
                step_order=order,
                step_type=stype,
                status=RunStatus.PENDING,
            )
            db.add(rs)
            step_rows[stype] = rs
        await db.commit()

        # Helpers to transition step status (idempotent for RUNNING transition)
        _step_started: set[StepType] = set()

        async def _begin_step(stype: StepType) -> None:
            if stype in _step_started:
                return
            _step_started.add(stype)
            rs = step_rows[stype]
            rs.status = RunStatus.RUNNING
            rs.started_at = datetime.now(timezone.utc)
            await db.commit()
            # Broadcast step status change via log broadcast so live consumers see it
            try:
                _log_broadcast.put_nowait({
                    "run_id": run_id,
                    "step_update": {
                        "step_type": stype.value,
                        "status": RunStatus.RUNNING.value,
                        "started_at": rs.started_at.isoformat(),
                    },
                })
            except asyncio.QueueFull:
                pass

        async def _finish_step(
            stype: StepType,
            status: RunStatus,
            records_in: int = 0,
            records_out: int = 0,
            error_message: Optional[str] = None,
        ) -> None:
            rs = step_rows[stype]
            rs.status = status
            rs.finished_at = datetime.now(timezone.utc)
            if rs.started_at:
                rs.duration_seconds = (rs.finished_at - rs.started_at).total_seconds()
            rs.records_in = records_in
            rs.records_out = records_out
            if error_message:
                rs.error_message = error_message
            await db.commit()

        source = extract_cfg.source_type

        # Validate app IDs in the unified apps list (no reserved names).
        _RESERVED_APP_IDS: frozenset[str] = frozenset({"default"})
        cfg_app_ids = [str(a.get("id", "")).strip() for a in (extract_cfg.apps or []) if str(a.get("id", "")).strip()]
        reserved = [i for i in cfg_app_ids if i.lower() in _RESERVED_APP_IDS]
        if reserved:
            raise ValueError(
                f"apps contains reserved id(s): {reserved}. "
                "Choose a meaningful identifier instead."
            )

        dates = _resolve_dates(extract_cfg, business_date)
        rows_per_seg = extract_cfg.rows_per_segment
        job_name = (extract_cfg.job_name or "PIPELINE").strip() or "PIPELINE"

        total_extracted = 0
        total_transformed = 0
        total_loaded = 0
        total_segs = 0

        # ── gRPC: server-side segments, iterate apps × dates ─────────────────
        if source == "grpc":
            # Build app list from unified apps config; fallback to pipeline_id
            grpc_app_list = [
                (str(a.get("id", "")), str(a.get("name", "")))
                for a in (extract_cfg.apps or [])
                if str(a.get("id", "")).strip()
            ] or [(str(run.pipeline_id), "")]
            for app_id, app_name in grpc_app_list:
                for date_str in dates:
                    await log(
                        f"Extracting gRPC app={app_id} date={date_str}",
                        step="extract",
                        extra={"app_id": app_id, "date": date_str},
                    )
                    await _begin_step(StepType.EXTRACT)
                    async for grpc_recs, seg, n_segs in _extract_grpc(
                        extract_cfg, app_id, date_str, log
                    ):
                        job = ExtractJob(
                            run_id=run_id,
                            application_id=app_id,
                            date=date_str,
                            segment=seg,
                            total_segments=n_segs,
                            status=RunStatus.RUNNING,
                            started_at=datetime.now(timezone.utc),
                        )
                        db.add(job)
                        await db.flush()
                        try:
                            total_extracted += len(grpc_recs)
                            run.records_extracted = total_extracted
                            await _begin_step(StepType.TRANSFORM)
                            transformed = _apply_transforms(grpc_recs, transform_cfg)
                            total_transformed += len(transformed)
                            run.records_transformed = total_transformed
                            output_path = ""
                            if transformed:
                                await _begin_step(StepType.LOAD)
                                output_path = await _load_segment(
                                    transformed, app_id, date_str, seg, load_cfg, log, job_name=job_name
                                )
                            total_loaded += len(transformed)
                            run.records_loaded = total_loaded
                            total_segs += 1
                            run.segments_processed = total_segs
                            job.status = RunStatus.COMPLETED
                            job.records_count = len(transformed)
                            job.output_path = output_path
                            job.output_format = load_cfg.target
                            job.finished_at = datetime.now(timezone.utc)
                            await log(
                                f"  seg={seg + 1}/{n_segs}: "
                                f"extracted={len(grpc_recs):,} loaded={len(transformed):,}"
                                f" -> {output_path}",
                                step="load",
                                extra={"segment": seg, "records": len(transformed)},
                            )
                        except Exception as exc:
                            tb = traceback.format_exc()
                            job.status = RunStatus.FAILED
                            job.error_message = str(exc)
                            job.finished_at = datetime.now(timezone.utc)
                            await log(
                                f"  seg={seg} FAILED: {exc}",
                                level="ERROR",
                                step="extract",
                                extra={"segment": seg, "error": str(exc)},
                            )
                            db.add(ServiceError(
                                service="etl_engine",
                                level="ERROR",
                                message=str(exc),
                                traceback=tb,
                                context={"run_id": run_id, "app_id": app_id,
                                         "date": date_str, "segment": seg},
                            ))
                        await db.commit()

                    if load_cfg.target == "spark_table":
                        try:
                            tbl = await spark_service.merge_and_register_table(
                                app_id, date_str,
                                job_name=job_name,
                                table_name=load_cfg.table_name,
                                namespace_db=load_cfg.namespace_db,
                                mode=load_cfg.mode or "overwrite",
                            )
                            await log(f"  Saved catalog table: {tbl}", step="load")
                        except Exception as exc:
                            await log(f"  Spark table skipped: {exc}", level="WARN")

        # ── JDBC / JSON / CSV / DW: read all → chunk by rows_per_segment ──────────
        else:
            # Build app list from unified apps config; fallback to pipeline_id
            fallback_app_id = str(run.pipeline_id)
            app_list: list[tuple[Optional[str], Optional[str]]] = [
                (str(a.get("id", "")), str(a.get("name", "")))
                for a in (extract_cfg.apps or [])
                if str(a.get("id", "")).strip()
            ] or [(fallback_app_id, "")]

            for app_id, app_name in app_list:

                for date_str in dates:
                    await log(
                        f"Extracting {source.upper()} date={date_str}"
                        + (f" app={app_name or app_id}" if app_id or app_name else ""),
                        step="extract",
                        extra={"date": date_str, "source": source},
                    )
                    await _begin_step(StepType.EXTRACT)

                    if source == "jdbc":
                        all_records = await _extract_jdbc(
                            extract_cfg, date_str, log, db,
                            business_date=business_date, app_id=app_id,
                        )
                        _dw_segment_delay = 0.0
                    elif source == "datawarehouse":
                        all_records, _dw_segment_delay = await _extract_datawarehouse(
                            extract_cfg, date_str, log, db,
                            business_date=business_date, app_id=app_id, app_name=app_name,
                            rows_per_segment=rows_per_seg,
                        )
                    else:
                        all_records = await _extract_file(extract_cfg, log)
                        _dw_segment_delay = 0.0

                    total_extracted += len(all_records)
                    run.records_extracted = total_extracted

                    chunks = _chunk_records(all_records, rows_per_seg)
                    n_segs = len(chunks)

                    await log(
                        f"  {len(all_records):,} records → {n_segs} segment"
                        f"{'s' if n_segs != 1 else ''} of {rows_per_seg:,} rows",
                        step="extract",
                        extra={"total_records": len(all_records), "segments": n_segs},
                    )

                    if not chunks:
                        await log("  No records — skipping load", level="WARN", step="load")
                        continue

                    _seg_delay = _dw_segment_delay if source == "datawarehouse" else 0.0
                    for seg_idx, chunk in enumerate(chunks):
                        job = ExtractJob(
                            run_id=run_id,
                            application_id=app_id,
                            date=date_str,
                            segment=seg_idx,
                            total_segments=n_segs,
                            status=RunStatus.RUNNING,
                            started_at=datetime.now(timezone.utc),
                        )
                        db.add(job)
                        await db.commit()  # visible as RUNNING immediately
                        if _seg_delay:
                            await log(
                                f"  Processing segment {seg_idx + 1}/{n_segs}…",
                                step="load",
                            )
                            await asyncio.sleep(_seg_delay)
                        try:
                            await _begin_step(StepType.TRANSFORM)
                            transformed = _apply_transforms(chunk, transform_cfg)
                            total_transformed += len(transformed)
                            run.records_transformed = total_transformed
                            output_path = ""
                            if transformed:
                                await _begin_step(StepType.LOAD)
                                output_path = await _load_segment(
                                    transformed, app_id, date_str, seg_idx, load_cfg, log, job_name=job_name
                                )
                            total_loaded += len(transformed)
                            run.records_loaded = total_loaded
                            total_segs += 1
                            run.segments_processed = total_segs
                            job.status = RunStatus.COMPLETED
                            job.records_count = len(transformed)
                            job.output_path = output_path
                            job.output_format = load_cfg.target
                            job.finished_at = datetime.now(timezone.utc)
                            await log(
                                f"  seg={seg_idx + 1}/{n_segs}: "
                                f"{len(transformed):,} records -> {output_path}",
                                step="load",
                                extra={"segment": seg_idx, "records": len(transformed)},
                            )
                        except Exception as exc:
                            tb = traceback.format_exc()
                            job.status = RunStatus.FAILED
                            job.error_message = str(exc)
                            job.finished_at = datetime.now(timezone.utc)
                            await log(
                                f"  seg={seg_idx} FAILED: {exc}",
                                level="ERROR",
                                step="load",
                            )
                            db.add(ServiceError(
                                service="etl_engine",
                                level="ERROR",
                                message=str(exc),
                                traceback=tb,
                                context={"run_id": run_id, "source": source,
                                         "date": date_str, "segment": seg_idx},
                            ))
                        await db.commit()

                    if load_cfg.target == "spark_table":
                        try:
                            tbl = await spark_service.merge_and_register_table(
                                app_id, date_str,
                                job_name=job_name,
                                table_name=load_cfg.table_name,
                                namespace_db=load_cfg.namespace_db,
                                mode=load_cfg.mode or "overwrite",
                            )
                            await log(f"  Saved catalog table: {tbl}", step="load")
                        except Exception as exc:
                            await log(f"  Spark table skipped: {exc}", level="WARN")

        run.status = RunStatus.COMPLETED
        run.finished_at = datetime.now(timezone.utc)
        if run.started_at:
            run.duration_seconds = (run.finished_at - run.started_at).total_seconds()
        await log(
            f"Pipeline complete — extracted={total_extracted:,} "
            f"transformed={total_transformed:,} "
            f"loaded={total_loaded:,} segments={total_segs}",
            step="done",
        )
        # Finalise step statuses — any step not yet started is skipped (e.g. empty source)
        for stype, records_in, records_out in [
            (StepType.EXTRACT, 0, total_extracted),
            (StepType.TRANSFORM, total_extracted, total_transformed),
            (StepType.LOAD, total_transformed, total_loaded),
        ]:
            rs = step_rows[stype]
            if rs.status in (RunStatus.RUNNING,):
                await _finish_step(stype, RunStatus.COMPLETED, records_in=records_in, records_out=records_out)
            elif rs.status == RunStatus.PENDING:
                # Never started (e.g. no data)
                rs.status = RunStatus.SKIPPED
        await db.commit()

    except asyncio.CancelledError:
        run.status = RunStatus.CANCELLED
        run.finished_at = datetime.now(timezone.utc)
        await log("Pipeline cancelled", level="WARN", step="done")
        # Mark all in-progress or pending steps as cancelled
        for stype in [StepType.EXTRACT, StepType.TRANSFORM, StepType.LOAD]:
            rs = step_rows.get(stype)
            if rs and rs.status in (RunStatus.RUNNING, RunStatus.PENDING):
                rs.status = RunStatus.CANCELLED
                if rs.status == RunStatus.RUNNING and rs.started_at:
                    rs.finished_at = datetime.now(timezone.utc)
                    rs.duration_seconds = (rs.finished_at - rs.started_at).total_seconds()
        await db.commit()
        raise

    except Exception as exc:
        tb = traceback.format_exc()
        run.status = RunStatus.FAILED
        run.finished_at = datetime.now(timezone.utc)
        run.error_message = str(exc)
        run.error_traceback = tb
        await log(f"Pipeline FAILED: {exc}", level="ERROR", step="done")
        # Mark the currently-running step as failed; pending steps as skipped
        for stype in [StepType.EXTRACT, StepType.TRANSFORM, StepType.LOAD]:
            rs = step_rows.get(stype)
            if rs:
                if rs.status == RunStatus.RUNNING:
                    await _finish_step(stype, RunStatus.FAILED, error_message=str(exc))
                elif rs.status == RunStatus.PENDING:
                    rs.status = RunStatus.SKIPPED
        db.add(ServiceError(
            service="etl_engine",
            level="ERROR",
            message=str(exc),
            traceback=tb,
            context={"run_id": run_id},
        ))

    finally:
        await db.commit()
        _active_runs.pop(run_id, None)


async def cancel_run(run_id: int) -> bool:
    task = _active_runs.get(run_id)
    if task and not task.done():
        task.cancel()
        return True
    return False
