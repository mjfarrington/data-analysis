"""
ETL Execution Engine — orchestrates Extract, Transform, Load pipelines.
Supports sources: gRPC, JDBC (SQLAlchemy), JSON, CSV.
Runs asynchronously and emits log events via an asyncio queue.
"""
from __future__ import annotations

import asyncio
import logging
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator, Optional

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.etl import ETLRun, ETLRunLog, ExtractJob, RunStatus, ServiceError
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

    # Deduplication
    if cfg.dedup and cfg.dedup_keys:
        seen: set = set()
        deduped: list[dict] = []
        for r in records:
            key = tuple(r.get(k) for k in cfg.dedup_keys)
            if key not in seen:
                seen.add(key)
                deduped.append(r)
        records = deduped

    return records


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


async def _resolve_sql(cfg: ExtractConfig, db: AsyncSession) -> str:
    """Return the SQL string from inline text or referenced SqlFile."""
    if cfg.jdbc_sql:
        return cfg.jdbc_sql.strip()
    if cfg.jdbc_sql_file_id:
        from app.models.etl import SqlFile
        sql_file = await db.get(SqlFile, cfg.jdbc_sql_file_id)
        if not sql_file:
            raise ValueError(f"SqlFile id={cfg.jdbc_sql_file_id} not found")
        return sql_file.content.strip()
    if cfg.jdbc_table:
        return f"SELECT * FROM {cfg.jdbc_table}"
    raise ValueError(
        "JDBC source requires one of: jdbc_sql, jdbc_sql_file_id, or jdbc_table"
    )


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


async def _extract_jdbc(
    cfg: ExtractConfig,
    date_str: Optional[str],
    log_fn,
    db: AsyncSession,
) -> list[dict]:
    sql = await _resolve_sql(cfg, db)
    await log_fn(
        f"  JDBC: {cfg.jdbc_url!r} — SQL {len(sql)} chars"
        + (f" filtered on {cfg.jdbc_date_column}={date_str!r}" if cfg.jdbc_date_column and date_str else ""),
        step="extract",
    )
    return await asyncio.to_thread(
        _read_jdbc_sync,
        cfg.jdbc_url,
        sql,
        cfg.jdbc_date_column,
        date_str,
    )


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

    path = Path(settings.DATA_DIR) / "sources" / file_path
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
def _resolve_dates(cfg: ExtractConfig) -> list[str]:
    dates: list[str] = list(cfg.dates or [])
    if not dates and cfg.date_from and cfg.date_to:
        from datetime import date, timedelta as td
        d = date.fromisoformat(cfg.date_from)
        end = date.fromisoformat(cfg.date_to)
        while d <= end:
            dates.append(d.isoformat())
            d += td(days=1)
    if not dates:
        dates = [datetime.now(timezone.utc).strftime("%Y-%m-%d")]
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
) -> str:
    fmt = load_cfg.target if load_cfg.target in ("parquet", "csv") else "parquet"
    try:
        if fmt == "parquet":
            return await spark_service.save_records_parquet(
                records, app_id, date_str, seg_index, mode=load_cfg.mode
            )
        return await spark_service.save_records_csv(records, app_id, date_str, seg_index)
    except Exception as spark_err:
        await log_fn(f"  Spark unavailable ({spark_err}), falling back to CSV", level="WARN")
        return await spark_service.save_records_csv(records, app_id, date_str, seg_index)
# ─────────────────────────────────────────────────────────────────────────────
# Core runner
# ─────────────────────────────────────────────────────────────────────────────
async def execute_pipeline(
    db: AsyncSession,
    run: ETLRun,
    extract_cfg: ExtractConfig,
    transform_cfg: TransformConfig,
    load_cfg: LoadConfig,
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

        source = extract_cfg.source_type
        dates = _resolve_dates(extract_cfg)
        rows_per_seg = extract_cfg.rows_per_segment

        total_extracted = 0
        total_loaded = 0
        total_segs = 0

        # ── gRPC: server-side segments, iterate apps × dates ─────────────────
        if source == "grpc":
            app_ids = extract_cfg.application_ids or ["APP001"]
            for app_id in app_ids:
                for date_str in dates:
                    await log(
                        f"Extracting gRPC app={app_id} date={date_str}",
                        step="extract",
                        extra={"app_id": app_id, "date": date_str},
                    )
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
                            transformed = _apply_transforms(grpc_recs, transform_cfg)
                            run.records_transformed = (run.records_transformed or 0) + len(transformed)
                            output_path = ""
                            if transformed:
                                output_path = await _load_segment(
                                    transformed, app_id, date_str, seg, load_cfg, log
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

                    if load_cfg.target == "spark_table" or load_cfg.table_name:
                        try:
                            tbl = await spark_service.merge_and_register_table(
                                app_id, date_str, load_cfg.table_name,
                                mode=load_cfg.mode or "overwrite",
                            )
                            await log(f"  Saved catalog table: {tbl}", step="load")
                        except Exception as exc:
                            await log(f"  Spark table skipped: {exc}", level="WARN")

        # ── JDBC / JSON / CSV: read all → chunk by rows_per_segment ──────────
        else:
            app_id = (extract_cfg.application_ids or ["default"])[0]

            for date_str in dates:
                await log(
                    f"Extracting {source.upper()} date={date_str}",
                    step="extract",
                    extra={"date": date_str, "source": source},
                )

                if source == "jdbc":
                    all_records = await _extract_jdbc(extract_cfg, date_str, log, db)
                else:
                    all_records = await _extract_file(extract_cfg, log)

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
                    await db.flush()
                    try:
                        transformed = _apply_transforms(chunk, transform_cfg)
                        run.records_transformed = (run.records_transformed or 0) + len(transformed)
                        output_path = ""
                        if transformed:
                            output_path = await _load_segment(
                                transformed, app_id, date_str, seg_idx, load_cfg, log
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

                if load_cfg.target == "spark_table" or load_cfg.table_name:
                    try:
                        tbl = await spark_service.merge_and_register_table(
                            app_id, date_str, load_cfg.table_name,
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
            f"loaded={total_loaded:,} segments={total_segs}",
            step="done",
        )

    except asyncio.CancelledError:
        run.status = RunStatus.CANCELLED
        run.finished_at = datetime.now(timezone.utc)
        await log("Pipeline cancelled", level="WARN", step="done")
        raise

    except Exception as exc:
        tb = traceback.format_exc()
        run.status = RunStatus.FAILED
        run.finished_at = datetime.now(timezone.utc)
        run.error_message = str(exc)
        run.error_traceback = tb
        await log(f"Pipeline FAILED: {exc}", level="ERROR", step="done")
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
