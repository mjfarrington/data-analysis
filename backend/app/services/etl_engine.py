"""
ETL Execution Engine — orchestrates Extract, Transform, Load pipelines.
Supports sources: JDBC (SQLAlchemy), DataWarehouse, JSON, CSV.
Runs asynchronously and emits log events via an asyncio queue.
"""
from __future__ import annotations

import asyncio
import json
import logging
import traceback
from datetime import date as _date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.etl import ETLRun, ETLRunLog, ExtractJob, RunStatus, RunStep, StepType, ServiceError
from app.schemas.etl import ExtractConfig, TransformConfig, LoadConfig
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
# Canvas transform pipeline executor
# ─────────────────────────────────────────────────────────────────────────────

def _execute_transform_step(
    records: list[dict],
    step_type: str,
    config: dict,
    lookup_tables: Optional[dict[int, dict[str, str]]] = None,
) -> tuple[list[dict], str]:
    """Execute one canvas transform node. Returns (records, summary_message)."""
    if not records:
        return records, f"[{step_type}] 0 records in — skipped"

    n_in = len(records)

    if step_type == "filter":
        conditions: list[dict] = config.get("conditions", [])
        logic = (config.get("logic") or "AND").upper()
        result = []
        for r in records:
            evals: list[bool] = []
            for cond in conditions:
                col = cond.get("column", "")
                op  = cond.get("operator", "=")
                val = str(cond.get("value", ""))
                raw = r.get(col)
                rv  = str(raw) if raw is not None else ""
                try:
                    if op == "=":         evals.append(rv == val)
                    elif op == "!=":      evals.append(rv != val)
                    elif op == ">":       evals.append(float(rv) > float(val))
                    elif op == "<":       evals.append(float(rv) < float(val))
                    elif op == ">=":      evals.append(float(rv) >= float(val))
                    elif op == "<=":      evals.append(float(rv) <= float(val))
                    elif op == "LIKE":    evals.append(val.replace("%", "").lower() in rv.lower())
                    elif op == "IN":      evals.append(rv in {v.strip() for v in val.split(",")})
                    elif op == "IS NULL": evals.append(raw is None or rv == "")
                    else:                 evals.append(True)
                except (ValueError, TypeError):
                    evals.append(False)
            keep = (all(evals) if evals else True) if logic == "AND" else (any(evals) if evals else True)
            if keep:
                result.append(r)
        dropped = n_in - len(result)
        return result, f"[filter] {n_in:,} → {len(result):,} rows ({dropped:,} removed, logic={logic})"

    elif step_type == "sort":
        columns: list[dict] = config.get("columns", [])
        for s in reversed(columns):
            col  = s.get("column", "")
            desc = (s.get("direction") or "asc").lower() == "desc"

            def _key(r: dict, c: str = col) -> tuple:
                v = r.get(c)
                if v is None:
                    return (1, "")
                try:
                    return (0, float(v))
                except (ValueError, TypeError):
                    return (0, str(v).lower())

            records = sorted(records, key=_key, reverse=desc)
        col_names = ", ".join(f"{s.get('column')} {'↓' if (s.get('direction','asc')=='desc') else '↑'}" for s in columns)
        return records, f"[sort] {n_in:,} rows sorted by {col_names or '—'}"

    elif step_type == "aggregate":
        group_by: list[str] = config.get("group_by", [])
        aggregations: list[dict] = config.get("aggregations", [])
        if not aggregations:
            return records, f"[aggregate] no aggregations configured — skipped"
        import pandas as pd
        df = pd.DataFrame(records)
        if not group_by:
            # Global aggregation across all rows
            row: dict = {}
            for agg in aggregations:
                col   = agg.get("column", "")
                fn    = (agg.get("function") or "sum").lower()
                alias = agg.get("alias") or col
                if col not in df.columns:
                    continue
                try:
                    num = pd.to_numeric(df[col], errors="coerce")
                    if fn == "sum":             row[alias] = float(num.sum())
                    elif fn in ("avg", "mean"): row[alias] = float(num.mean())
                    elif fn == "count":         row[alias] = int(df[col].count())
                    elif fn == "min":           row[alias] = num.min()
                    elif fn == "max":           row[alias] = num.max()
                    elif fn == "first":         row[alias] = df[col].iloc[0] if len(df) > 0 else None
                except Exception:
                    pass
            result_rows = [row] if row else records
            return result_rows, f"[aggregate] {n_in:,} rows → 1 row (global)"
        else:
            valid_gb = [c for c in group_by if c in df.columns]
            if not valid_gb:
                return records, f"[aggregate] group_by columns not found in data — skipped"
            agg_dict: dict[str, str] = {}
            renames: dict[str, str] = {}
            fn_map = {"avg": "mean", "average": "mean"}
            for agg in aggregations:
                col   = agg.get("column", "")
                fn    = (agg.get("function") or "sum").lower()
                alias = agg.get("alias") or col
                if col in df.columns:
                    agg_dict[col] = fn_map.get(fn, fn)
                    renames[col]  = alias
            if not agg_dict:
                return records, f"[aggregate] no valid columns — skipped"
            try:
                grouped = df.groupby(valid_gb).agg(agg_dict).reset_index()
                grouped = grouped.rename(columns=renames)
                result_rows = grouped.to_dict(orient="records")
                return result_rows, f"[aggregate] {n_in:,} → {len(result_rows):,} groups by {valid_gb}"
            except Exception as exc:
                return records, f"[aggregate] failed: {exc} — skipped"

    elif step_type == "lookup":
        dict_id_raw = config.get("dict_id")
        match_col = config.get("match_column", "")
        out_col   = config.get("output_column", "")
        default   = config.get("default_value", "")
        if not dict_id_raw or not match_col or not out_col:
            return records, f"[lookup] incomplete config — skipped"
        try:
            dict_id = int(dict_id_raw)
        except (ValueError, TypeError):
            return records, f"[lookup] invalid dict_id — skipped"
        lut = (lookup_tables or {}).get(dict_id, {})
        if not lut:
            return records, f"[lookup] dict {dict_id} not found or empty — skipped"
        hits = 0
        for r in records:
            key  = str(r.get(match_col, ""))
            mapped = lut.get(key)
            if mapped is not None:
                hits += 1
            r[out_col] = mapped if mapped is not None else default
        return records, f"[lookup] {hits:,}/{n_in:,} rows matched dict {dict_id} → '{out_col}'"

    elif step_type in ("join", "sql_transform", "notebook_transform"):
        return records, f"[{step_type}] not supported in current execution mode — skipped"

    return records, f"[{step_type}] unknown type — skipped"


def _execute_transform_pipeline(
    records: list[dict],
    steps: list,
    lookup_tables: Optional[dict[int, dict[str, str]]] = None,
) -> tuple[list[dict], list[str]]:
    """Apply an ordered list of TransformStep objects. Returns (records, log_messages)."""
    messages: list[str] = []
    for step in steps:
        records, msg = _execute_transform_step(records, step.node_type, step.config, lookup_tables)
        messages.append(msg)
    return records, messages


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
    row_limit: Optional[int] = None,
) -> list[dict]:
    """Synchronous JDBC read via SQLAlchemy + pandas (runs in thread pool)."""
    import re
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
        d_norm = date_str.replace("-", "").replace("/", "")
        params["biz_date"] = f"{d_norm[:4]}-{d_norm[4:6]}-{d_norm[6:8]}" if len(d_norm) == 8 else date_str

    if row_limit and row_limit > 0:
        stripped = query.rstrip().rstrip(";")
        has_limit = bool(re.search(r'\bLIMIT\s+\d+', stripped, re.IGNORECASE))
        if not has_limit:
            query = f"{stripped} LIMIT {row_limit}"

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
    limit_info = f" LIMIT {cfg.jdbc_row_limit}" if cfg.jdbc_row_limit else ""
    await log_fn(
        f"  JDBC: {jdbc_url!r} — SQL {len(sql)} chars{limit_info}"
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
        cfg.jdbc_row_limit,
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


def _resolve_parquet_output_dir(
    extract_cfg: ExtractConfig,
    date_str: str,
    job_name: str,
    app_id: str,
    parquet_root: Path,
) -> Path:
    """Compute the parquet output directory for a JDBC extract chunk.

    Priority:
      1. parquet_output_dir (fixed subdir relative to parquet_root)
      2. parquet_path_template (supports {business_date}, {pipeline_name}, {app_id})
      3. Default: parquet_root / date_str / job_name / app_id
    """
    if extract_cfg.parquet_output_dir:
        base = parquet_root / extract_cfg.parquet_output_dir / date_str / job_name / app_id
    elif extract_cfg.parquet_path_template:
        tpl = (
            extract_cfg.parquet_path_template
            .replace("{business_date}", date_str)
            .replace("{pipeline_name}", job_name.lower())
            .replace("{app_id}", app_id)
        )
        base = parquet_root / tpl
    else:
        base = parquet_root / date_str / job_name / app_id
    base.mkdir(parents=True, exist_ok=True)
    return base


def _chunk_records(records: list[dict], chunk_size: int) -> list[list[dict]]:
    if not records:
        return []
    return [records[i : i + chunk_size] for i in range(0, len(records), chunk_size)]


# ─────────────────────────────────────────────────────────────────────────────
# Date list helper
# ─────────────────────────────────────────────────────────────────────────────
def _resolve_dates(cfg: ExtractConfig, business_date: Optional[str] = None) -> list[str]:
    def _compact(s: str) -> str:
        """Normalise any date string to compact YYYYMMDD (strip dashes/slashes)."""
        return s.replace("-", "").replace("/", "")

    dates: list[str] = [_compact(d) for d in (cfg.dates or [])]
    if not dates and cfg.date_from and cfg.date_to:
        from datetime import date, timedelta as td
        d = date.fromisoformat(cfg.date_from)
        end = date.fromisoformat(cfg.date_to)
        while d <= end:
            dates.append(d.strftime("%Y%m%d"))
            d += td(days=1)
    if not dates:
        # Prefer the business_date from execution context; fall back to today
        raw = business_date or datetime.now(timezone.utc).strftime("%Y-%m-%d")
        dates = [_compact(raw)]
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

        # ── Initialise per-node run tracking rows ────────────────────────────
        # Build the step list from the actual canvas pipeline:
        #   extract → each transform node (filter/sort/…) → load
        _LABEL_MAP = {
            "filter": "Filter", "join": "Join", "sort": "Sort",
            "lookup": "Lookup", "sql_transform": "SQL Transform",
            "aggregate": "Aggregate", "notebook_transform": "Notebook Transform",
        }
        _step_specs: list[tuple[str, str, str]] = []  # (key, step_type, label)
        _step_specs.append(("extract", "extract", "Extract"))
        for _xs in transform_cfg.transforms_pipeline:
            _xkey = f"xform_{_xs.node_id}" if getattr(_xs, 'node_id', None) else f"xform_{_xs.node_type}"
            _step_specs.append((_xkey, _xs.node_type, _LABEL_MAP.get(_xs.node_type, _xs.node_type.replace('_', ' ').title())))
        _step_specs.append(("load", "load", "Load"))

        step_rows: dict[str, RunStep] = {}
        for _order, (_key, _stype, _label) in enumerate(_step_specs):
            _rs = RunStep(
                run_id=run_id,
                step_order=_order,
                step_type=_stype,
                step_label=_label,
                status=RunStatus.PENDING,
            )
            db.add(_rs)
            step_rows[_key] = _rs
        await db.flush()   # populate .id fields before creating children
        await db.commit()

        # Counter for dynamically inserted step rows (app/chunk); starts after static steps
        _dynamic_order = len(_step_specs)

        # Helpers to transition step status (idempotent for RUNNING transition)
        _step_started: set[str] = set()

        async def _begin_step(key: str) -> None:
            if key in _step_started:
                return
            _step_started.add(key)
            rs = step_rows[key]
            rs.status = RunStatus.RUNNING
            rs.started_at = datetime.now(timezone.utc)
            await db.commit()
            try:
                _log_broadcast.put_nowait({
                    "run_id": run_id,
                    "step_update": {
                        "step_type": rs.step_type,
                        "status": RunStatus.RUNNING.value,
                        "started_at": rs.started_at.isoformat(),
                    },
                })
            except asyncio.QueueFull:
                pass

        async def _finish_step(
            key: str,
            status: RunStatus,
            records_in: int = 0,
            records_out: int = 0,
            error_message: Optional[str] = None,
        ) -> None:
            rs = step_rows[key]
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

        # ── S3 fast-path: Spark-native ingest, bypasses segment loop ─────────
        if source == "s3":
            if not extract_cfg.s3_connection_id:
                raise ValueError("S3 source requires s3_connection_id.")
            if not extract_cfg.s3_target_table:
                raise ValueError("S3 source requires s3_target_table.")
            from app.models.etl import Connection as ConnModel
            from app.services.crypto import decrypt_password
            from app.services.s3_service import config_from_connection, ingest_sync

            conn = await db.get(ConnModel, extract_cfg.s3_connection_id)
            if not conn:
                raise ValueError(f"S3 connection {extract_cfg.s3_connection_id} not found.")
            plain_secret = decrypt_password(conn.password_encrypted) if conn.password_encrypted else None
            s3_cfg = config_from_connection(conn, plain_secret)

            await _begin_step("extract")
            await log("S3 ingest started", step="extract")
            rows_out = 0

            def _run_ingest():
                nonlocal rows_out
                for ev in ingest_sync(
                    s3_cfg,
                    prefix=extract_cfg.s3_prefix or "",
                    pattern=extract_cfg.s3_pattern,
                    fmt=extract_cfg.s3_format,
                    csv_sep=extract_cfg.s3_csv_sep,
                    transform_sql=extract_cfg.s3_transform_sql,
                    target_db=extract_cfg.s3_target_db,
                    target_table=extract_cfg.s3_target_table,
                    write_mode=extract_cfg.s3_write_mode,
                ):
                    if ev.get("event") == "done":
                        rows_out = ev.get("rows", 0)

            await asyncio.to_thread(_run_ingest)
            await _finish_step("extract", RunStatus.COMPLETED, records_in=rows_out, records_out=rows_out)
            await _finish_step("load", RunStatus.COMPLETED, records_in=rows_out, records_out=rows_out)
            run.status = RunStatus.COMPLETED
            run.finished_at = datetime.now(timezone.utc)
            run.total_records_extracted = rows_out
            run.total_records_loaded = rows_out
            await db.commit()
            await log(f"S3 ingest complete — {rows_out:,} rows written to {extract_cfg.s3_target_db}.{extract_cfg.s3_target_table}", step="extract")
            return

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

        # Store parameters needed for a potential spark-table retry later
        run.run_metadata = {
            **(run.run_metadata or {}),
            "job_name": job_name,
            "namespace_db": load_cfg.namespace_db,
            "table_name": load_cfg.table_name,
            "mode": load_cfg.mode or "overwrite",
        }
        await db.commit()

        # Pre-load any dictionaries needed by lookup steps
        lookup_tables: dict[int, dict[str, str]] = {}
        lookup_steps = [s for s in transform_cfg.transforms_pipeline if s.node_type == "lookup"]
        for step in lookup_steps:
            dict_id_raw = step.config.get("dict_id")
            if not dict_id_raw:
                continue
            try:
                dict_id = int(dict_id_raw)
            except (ValueError, TypeError):
                continue
            if dict_id in lookup_tables:
                continue
            try:
                from app.models.etl import Dictionary, DictionaryEntry
                dict_obj = await db.get(Dictionary, dict_id)
                if dict_obj:
                    from sqlalchemy import select
                    rows = await db.execute(select(DictionaryEntry).where(DictionaryEntry.dictionary_id == dict_id))
                    entries = rows.scalars().all()
                    lookup_tables[dict_id] = {str(e.key): str(e.value) for e in entries}
                    await log(f"Loaded lookup dict {dict_id}: {len(lookup_tables[dict_id])} entries", step="init")
            except Exception as exc:
                await log(f"Could not load lookup dict {dict_id}: {exc}", level="WARN", step="init")

        total_extracted = 0
        total_transformed = 0
        total_loaded = 0
        total_segs = 0
        spark_table_failed = False

        # ── JDBC / JSON / CSV / DW: read all → chunk by rows_per_segment ──────────
        if True:  # single extraction path
            # Build app list from unified apps config; fallback to pipeline_id
            fallback_app_id = str(run.pipeline_id)
            app_list: list[tuple[Optional[str], Optional[str]]] = [
                (str(a.get("id", "")), str(a.get("name", "")))
                for a in (extract_cfg.apps or [])
                if str(a.get("id", "")).strip()
            ] or [(fallback_app_id, "")]

            # Start the single extract parent step before any app iterations
            await _begin_step("extract")

            for app_id, app_name in app_list:
                # ── Create an app-level step (child of extract) ─────────────────
                _app_key = f"app_{app_id}"
                _app_label = app_name.strip() if app_name and app_name.strip() else str(app_id)
                _app_rs = RunStep(
                    run_id=run_id,
                    step_order=_dynamic_order,
                    step_type="app",
                    step_label=_app_label,
                    parent_step_id=step_rows["extract"].id,
                    status=RunStatus.RUNNING,
                    started_at=datetime.now(timezone.utc),
                )
                _dynamic_order += 1
                db.add(_app_rs)
                await db.flush()   # populate .id so chunks can reference it
                await db.commit()  # visible to API polls immediately
                step_rows[_app_key] = _app_rs

                _app_extracted = 0

                for date_str in dates:
                    await log(
                        f"Extracting {source.upper()} date={date_str}"
                        + (f" app={_app_label}" if app_id else ""),
                        step="extract",
                        extra={"date": date_str, "source": source},
                    )

                    if source == "jdbc":
                        all_records = await _extract_jdbc(
                            extract_cfg, date_str, log, db,
                            business_date=business_date, app_id=app_id,
                        )
                        _dw_segment_delay = 5.0  # simulate processing time per chunk
                    elif source == "datawarehouse":
                        all_records, _dw_segment_delay = await _extract_datawarehouse(
                            extract_cfg, date_str, log, db,
                            business_date=business_date, app_id=app_id, app_name=app_name,
                            rows_per_segment=rows_per_seg,
                        )
                    else:
                        if source not in ("csv", "json"):
                            raise ValueError(
                                f"Source type '{source}' is not supported. "
                                "Please edit the pipeline and select a valid source (JDBC, DataWarehouse, CSV or JSON)."
                            )
                        all_records = await _extract_file(extract_cfg, log)
                        _dw_segment_delay = 0.0

                    total_extracted += len(all_records)
                    _app_extracted += len(all_records)
                    run.records_extracted = total_extracted

                    chunks = _chunk_records(all_records, rows_per_seg)
                    n_segs = len(chunks)

                    await log(
                        f"  {len(all_records):,} records → {n_segs} chunk"
                        f"{'s' if n_segs != 1 else ''} of {rows_per_seg:,} rows",
                        step="extract",
                        extra={"total_records": len(all_records), "segments": n_segs},
                    )

                    if not chunks:
                        await log("  No records — skipping load", level="WARN", step="load")
                        continue

                    # JDBC pyarrow schema tracking: inferred from first chunk, enforced on rest
                    _jdbc_schema: Optional[Any] = None
                    _jdbc_output_dir: Optional[Path] = None

                    _seg_delay = _dw_segment_delay
                    for seg_idx, chunk in enumerate(chunks):
                        _ckey = f"chunk_{app_id}_{seg_idx + 1}"
                        # Create chunk step RUNNING right now — truly dynamic, one at a time
                        _crs = RunStep(
                            run_id=run_id,
                            step_order=_dynamic_order,
                            step_type="chunk",
                            step_label=f"Chunk {seg_idx + 1}",
                            parent_step_id=_app_rs.id,
                            status=RunStatus.RUNNING,
                            started_at=datetime.now(timezone.utc),
                        )
                        _dynamic_order += 1
                        db.add(_crs)
                        await db.flush()  # get .id before processing
                        step_rows[_ckey] = _crs
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
                        await db.commit()  # chunk step + job visible immediately
                        if _seg_delay:
                            await log(
                                f"  Chunk {seg_idx + 1}/{n_segs}: {len(chunk):,} records"
                                + (f" — waiting {_seg_delay:.0f}s…" if _seg_delay else ""),
                                step="extract",
                            )
                            await asyncio.sleep(_seg_delay)
                        try:
                            # Apply legacy simple transforms first
                            transformed = _apply_transforms(chunk, transform_cfg)
                            # Execute each canvas transform node as its own tracked step
                            if transform_cfg.transforms_pipeline:
                                for _xs in transform_cfg.transforms_pipeline:
                                    _xkey = f"xform_{_xs.node_id}" if getattr(_xs, 'node_id', None) else f"xform_{_xs.node_type}"
                                    await _begin_step(_xkey)
                                    n_before = len(transformed)
                                    transformed, xmsg = _execute_transform_step(
                                        transformed, _xs.node_type, _xs.config, lookup_tables
                                    )
                                    await log(f"  {xmsg}", step=_xs.node_type)
                                    await _finish_step(_xkey, RunStatus.COMPLETED, records_in=n_before, records_out=len(transformed))
                            total_transformed += len(transformed)
                            run.records_transformed = total_transformed
                            output_path = ""
                            if transformed:
                                await _begin_step("load")
                                if source == "jdbc":
                                    # JDBC: write using pyarrow with strict schema enforcement,
                                    # output path from the load_parquet canvas node config.
                                    from app.services.jdbc_service import (
                                        _write_chunk_pyarrow_sync,
                                        schema_to_dict,
                                    )
                                    _jdbc_output_dir = _resolve_parquet_output_dir(
                                        extract_cfg, date_str, job_name, app_id,
                                        settings.parquet_path,
                                    )
                                    out_file = _jdbc_output_dir / f"part_{seg_idx:05d}.parquet"
                                    _jdbc_schema, output_path = await asyncio.to_thread(
                                        _write_chunk_pyarrow_sync,
                                        transformed,
                                        out_file,
                                        _jdbc_schema,
                                    )
                                    if seg_idx == 0:
                                        # Log schema after the first chunk
                                        schema_fields = schema_to_dict(_jdbc_schema)
                                        field_preview = ", ".join(
                                            f"{f['name']}:{f['type']}" for f in schema_fields[:6]
                                        )
                                        if len(schema_fields) > 6:
                                            field_preview += f" … +{len(schema_fields) - 6} more"
                                        await log(
                                            f"  Schema inferred: {len(schema_fields)} field(s) — {field_preview}",
                                            step="extract",
                                            extra={"schema": schema_fields},
                                        )
                                else:
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
                            job.output_format = "parquet" if source == "jdbc" else load_cfg.target
                            job.finished_at = datetime.now(timezone.utc)
                            await log(
                                f"  seg={seg_idx + 1}/{n_segs}: "
                                f"{len(transformed):,} records -> {output_path}",
                                step="load",
                                extra={"segment": seg_idx, "records": len(transformed)},
                            )
                            await _finish_step(_ckey, RunStatus.COMPLETED, records_in=len(chunk), records_out=len(transformed))
                        except Exception as exc:
                            tb = traceback.format_exc()
                            job.status = RunStatus.FAILED
                            job.error_message = str(exc)
                            job.finished_at = datetime.now(timezone.utc)
                            await log(f"  seg={seg_idx} FAILED: {exc}", level="ERROR", step="load")
                            await _finish_step(_ckey, RunStatus.FAILED, error_message=str(exc))
                            db.add(ServiceError(
                                service="etl_engine",
                                level="ERROR",
                                message=str(exc),
                                traceback=tb,
                                context={"run_id": run_id, "source": source,
                                         "date": date_str, "segment": seg_idx},
                            ))
                        await db.commit()

                    # After all chunks for this date: persist schema.json and store in run metadata
                    if source == "jdbc" and _jdbc_schema is not None and _jdbc_output_dir is not None:
                        from app.services.jdbc_service import schema_to_dict
                        schema_list = schema_to_dict(_jdbc_schema)
                        schema_path = _jdbc_output_dir / "schema.json"
                        schema_path.write_text(
                            json.dumps(schema_list, indent=2), encoding="utf-8"
                        )
                        await log(
                            f"  Schema persisted: {schema_path.relative_to(settings.parquet_path)}",
                            step="extract",
                            extra={"schema_path": str(schema_path)},
                        )
                        run.run_metadata = {
                            **(run.run_metadata or {}),
                            "jdbc_schema": schema_list,
                            "jdbc_schema_path": str(schema_path),
                        }
                        await db.commit()

                    if load_cfg.target == "spark_table" and source != "jdbc":
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
                            spark_table_failed = True
                            spark_err_msg = f"Spark table registration failed (app={app_id}, date={date_str}): {exc}"
                            run.error_message = spark_err_msg
                            await log(f"  Spark table skipped: {exc}", level="WARN")

                # Finish app step after all dates for this app are done
                await _finish_step(_app_key, RunStatus.COMPLETED,
                                   records_in=0, records_out=_app_extracted)

        run.status = RunStatus.COMPLETED_WITH_WARNINGS if spark_table_failed else RunStatus.COMPLETED
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
        for _key, _rs in step_rows.items():
            if _rs.status == RunStatus.RUNNING:
                if _key == "load":
                    await _finish_step(_key, RunStatus.COMPLETED, records_in=total_transformed, records_out=total_loaded)
                elif _key == "extract":
                    await _finish_step(_key, RunStatus.COMPLETED, records_in=0, records_out=total_extracted)
                else:
                    await _finish_step(_key, RunStatus.COMPLETED)
            elif _rs.status == RunStatus.PENDING:
                _rs.status = RunStatus.SKIPPED
        await db.commit()

    except asyncio.CancelledError:
        run.status = RunStatus.CANCELLED
        run.finished_at = datetime.now(timezone.utc)
        await log("Pipeline cancelled", level="WARN", step="done")
        # Mark all in-progress or pending steps as cancelled
        for _rs in step_rows.values():
            if _rs.status in (RunStatus.RUNNING, RunStatus.PENDING):
                was_running = _rs.status == RunStatus.RUNNING
                _rs.status = RunStatus.CANCELLED
                if was_running and _rs.started_at:
                    _rs.finished_at = datetime.now(timezone.utc)
                    _rs.duration_seconds = (_rs.finished_at - _rs.started_at).total_seconds()
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
        for _key, _rs in step_rows.items():
            if _rs.status == RunStatus.RUNNING:
                await _finish_step(_key, RunStatus.FAILED, error_message=str(exc))
            elif _rs.status == RunStatus.PENDING:
                _rs.status = RunStatus.SKIPPED
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
    # First try to cancel the live asyncio task
    task = _active_runs.get(run_id)
    if task and not task.done():
        task.cancel()
        return True

    # Fall back: force-cancel directly in the DB (handles backend restarts /
    # tasks that died without cleaning up their status).
    from app.core.database import AsyncSessionLocal
    from sqlalchemy import update, and_
    async with AsyncSessionLocal() as db:
        result = await db.execute(
            update(ETLRun)
            .where(and_(ETLRun.id == run_id, ETLRun.status == RunStatus.RUNNING))
            .values(status=RunStatus.CANCELLED, finished_at=datetime.now(timezone.utc))
        )
        await db.execute(
            update(RunStep)
            .where(and_(RunStep.run_id == run_id, RunStep.status == RunStatus.RUNNING))
            .values(status=RunStatus.CANCELLED, finished_at=datetime.now(timezone.utc))
        )
        await db.commit()
        return result.rowcount > 0
