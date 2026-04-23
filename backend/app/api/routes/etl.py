from __future__ import annotations
import asyncio
import logging
import json
import re
from datetime import datetime, timezone
from typing import Optional
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func, desc
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import settings
from app.core.database import get_db
from app.models.etl import ETLPipeline, ETLRun, RunStatus, PipelineStatus, SqlFile, SqlFileVersion, PipelineDependency, ExecutionContext
from app.schemas.etl import (
    PipelineCreate, PipelineUpdate, PipelineResponse,
    RunTrigger, RunSummary, RunDetail,
    SqlFileCreate, SqlFileUpdate, SqlFileResponse,
    SqlFileVersionCreate,
    SqlVersionLabelsResponse, SqlVersionLabelsUpdate,
    GraphNode, GraphEdge, PipelineGraph,
    ExecutionContextResponse, ExecutionContextUpdate,
)
from app.services.etl_engine import execute_pipeline, cancel_run

router = APIRouter(prefix="/etl", tags=["ETL"])
logger = logging.getLogger(__name__)
DEFAULT_SQL_VERSION_LABELS = ["INITIAL", "DRAFT", "FINAL", "DEPRECATED"]


def _pipeline_to_job_name(name: str) -> str:
    """Derive a filesystem-safe job name from a pipeline name.

    'My Market Data' -> 'MY_MARKET_DATA'
    'Report v2.1'    -> 'REPORT_V2_1'
    """
    return re.sub(r"[^A-Z0-9]+", "_", name.upper()).strip("_") or "PIPELINE"


def _sql_dir(file_type: str):
    """Return (and create) the on-disk directory for an SQL file type."""
    from pathlib import Path
    base = Path(settings.SQL_EXTRACT_DIR if file_type == "extract" else settings.SQL_TRANSFORM_DIR)
    base.mkdir(parents=True, exist_ok=True)
    return base


def _sql_path(name: str, file_type: str):
    """Canonical on-disk path for an SQL file."""
    normalized = name.lower().strip()
    if not normalized.endswith(".sql"):
        normalized = f"{normalized}.sql"
    return _sql_dir(file_type) / normalized


def _sql_version_labels_path() -> Path:
    return Path(settings.STATIC_DIR) / "sql" / "version_labels.json"


def _read_sql_version_labels() -> list[str]:
    p = _sql_version_labels_path()
    if not p.exists():
        return DEFAULT_SQL_VERSION_LABELS.copy()
    try:
        raw = json.loads(p.read_text("utf-8"))
        labels = raw.get("labels") if isinstance(raw, dict) else None
        if not isinstance(labels, list):
            return DEFAULT_SQL_VERSION_LABELS.copy()
        cleaned = []
        for item in labels:
            text = str(item).strip().upper()
            if text and text not in cleaned:
                cleaned.append(text)
        return cleaned or DEFAULT_SQL_VERSION_LABELS.copy()
    except Exception:
        return DEFAULT_SQL_VERSION_LABELS.copy()


def _write_sql_version_labels(labels: list[str]) -> list[str]:
    cleaned = []
    for item in labels:
        text = str(item).strip().upper()
        if text and text not in cleaned:
            cleaned.append(text)
    cleaned = cleaned or DEFAULT_SQL_VERSION_LABELS.copy()
    p = _sql_version_labels_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"labels": cleaned}, indent=2), "utf-8")
    return cleaned


def _parse_version_number(version: str) -> int:
    m = re.search(r"(\d+)$", version or "")
    return int(m.group(1)) if m else 0


def _next_sql_version_number(sql_file: SqlFile) -> int:
    nums = [_parse_version_number(v.version) for v in (sql_file.versions or [])]
    return (max(nums) if nums else 0) + 1


def _normalise_version_label(label: str) -> str:
    return (label or "").strip().upper()


# Default namespace prefix used when none is configured.
_DEFAULT_NS_PREFIX = "data_"


def _resolve_ns_prefix(ctx: ExecutionContext | None) -> str:
    """Return the namespace prefix, falling back to the platform default."""
    if ctx and ctx.namespace_prefix:
        return ctx.namespace_prefix
    return _DEFAULT_NS_PREFIX


async def _apply_canvas_to_extract_cfg(
    pipeline: "ETLPipeline",
    base_cfg: "ExtractConfig",
    db: AsyncSession,
) -> "ExtractConfig":
    """Read canvas nodes and override ExtractConfig with the actual visual configuration.

    The canvas is the source of truth.  The stored extract_config is a legacy
    field that may be stale.  This function reads:
      - iterator node  → app list (from dictionary entries for selected_keys)
      - jdbc_extract   → source_type, connection, SQL, chunk_size
    """
    from app.schemas.etl import ExtractConfig as _ExtractConfig
    from sqlalchemy import select as _sel
    canvas = pipeline.canvas_config or {}
    nodes = canvas.get("nodes", [])
    updates: dict = {}

    for node in nodes:
        data = node.get("data", {})
        node_type = data.get("nodeType", "")
        cfg = data.get("config", {})

        if node_type == "iterator":
            dict_id = cfg.get("dictionary_id")
            selected_keys = [str(k) for k in (cfg.get("selected_keys") or []) if not str(k).isdigit()]
            if dict_id and selected_keys:
                from app.models.etl import DictionaryEntry
                rows = await db.execute(
                    _sel(DictionaryEntry)
                    .where(DictionaryEntry.dictionary_id == int(dict_id))
                    .where(DictionaryEntry.key.in_(selected_keys))
                )
                entries = rows.scalars().all()
                # Preserve order of selected_keys
                entry_map = {e.key: e for e in entries}
                apps = [
                    {"id": str(entry_map[k].key), "name": str(entry_map[k].value)}
                    for k in selected_keys
                    if k in entry_map
                ]
                if apps:
                    updates["apps"] = apps

        elif node_type == "jdbc_extract":
            updates["source_type"] = "jdbc"
            conn_id = cfg.get("connection_id")
            if conn_id is not None:
                updates["jdbc_connection_id"] = int(conn_id)
            sql = cfg.get("sql")
            if sql:
                updates["jdbc_sql"] = sql
            sql_file_id = cfg.get("sql_file_id")
            if sql_file_id:
                updates["jdbc_sql_file_id"] = int(sql_file_id)
            chunk_size = cfg.get("chunk_size")
            if chunk_size:
                updates["rows_per_segment"] = int(chunk_size)
            date_fmt = cfg.get("date_format")
            if date_fmt:
                updates["jdbc_date_var_format"] = date_fmt

        elif node_type == "s3_extract":
            updates["source_type"] = "s3"
            conn_id = cfg.get("connection_id")
            if conn_id is not None:
                updates["s3_connection_id"] = int(conn_id)
            if cfg.get("prefix") is not None:
                updates["s3_prefix"] = cfg["prefix"]
            if cfg.get("pattern"):
                updates["s3_pattern"] = cfg["pattern"]
            if cfg.get("format"):
                updates["s3_format"] = cfg["format"]
            if cfg.get("write_mode"):
                updates["s3_write_mode"] = cfg["write_mode"]
            if cfg.get("target_db"):
                updates["s3_target_db"] = cfg["target_db"]
            if cfg.get("target_table"):
                updates["s3_target_table"] = cfg["target_table"]
            if cfg.get("transform_sql"):
                updates["s3_transform_sql"] = cfg["transform_sql"]
            if cfg.get("csv_sep"):
                updates["s3_csv_sep"] = cfg["csv_sep"]

    if updates:
        return base_cfg.model_copy(update=updates)
    return base_cfg


def _build_context_response(ctx: ExecutionContext) -> ExecutionContextResponse:
    derived = None
    if ctx.business_date:
        date_compact = ctx.business_date.replace("-", "")
        prefix = ctx.namespace_prefix if ctx.namespace_prefix is not None else _DEFAULT_NS_PREFIX
        derived = f"{prefix}{date_compact}"
    # db_name overrides the derived prefix+date namespace
    namespace = ctx.db_name or derived
    return ExecutionContextResponse(
        id=ctx.id,
        business_date=ctx.business_date,
        namespace_prefix=ctx.namespace_prefix,
        db_name=ctx.db_name,
        namespace=namespace,
        updated_at=ctx.updated_at,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Pipelines
# ─────────────────────────────────────────────────────────────────────────────
@router.get("/pipelines", response_model=list[PipelineResponse])
async def list_pipelines(
    status: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    q = select(ETLPipeline).order_by(desc(ETLPipeline.updated_at))
    if status:
        q = q.where(ETLPipeline.status == status)
    result = await db.execute(q)
    pipelines = result.scalars().all()

    out = []
    for p in pipelines:
        runs_q = await db.execute(
            select(ETLRun)
            .where(ETLRun.pipeline_id == p.id)
            .order_by(desc(ETLRun.created_at))
            .limit(1)
        )
        last_run = runs_q.scalar_one_or_none()
        count_q = await db.execute(
            select(func.count()).where(ETLRun.pipeline_id == p.id)
        )
        total = count_q.scalar_one()
        resp = PipelineResponse.model_validate(p)
        resp.last_run = RunSummary.model_validate(last_run) if last_run else None
        resp.total_runs = total
        out.append(resp)
    return out


@router.get("/pipelines/{pid}", response_model=PipelineResponse)
async def get_pipeline(pid: int, db: AsyncSession = Depends(get_db)):
    pipeline = await db.get(ETLPipeline, pid)
    if not pipeline:
        raise HTTPException(status_code=404, detail="Pipeline not found")
    runs_q = await db.execute(
        select(ETLRun).where(ETLRun.pipeline_id == pid).order_by(desc(ETLRun.created_at)).limit(1)
    )
    last_run = runs_q.scalar_one_or_none()
    count_q = await db.execute(select(func.count()).where(ETLRun.pipeline_id == pid))
    resp = PipelineResponse.model_validate(pipeline)
    resp.last_run = RunSummary.model_validate(last_run) if last_run else None
    resp.total_runs = count_q.scalar_one()
    return resp


@router.post("/pipelines", response_model=PipelineResponse, status_code=201)
async def create_pipeline(
    body: PipelineCreate,
    db: AsyncSession = Depends(get_db),
):
    pipeline = ETLPipeline(
        name=body.name,
        category=body.category,
        description=body.description,
        extract_config=body.extract_config.model_dump(),
        transform_config=body.transform_config.model_dump(),
        load_config=body.load_config.model_dump(),
        schedule=body.schedule,
        schedule_enabled=body.schedule_enabled,
    )
    db.add(pipeline)
    await db.commit()
    await db.refresh(pipeline)
    resp = PipelineResponse.model_validate(pipeline)
    resp.total_runs = 0
    return resp


@router.put("/pipelines/{pid}", response_model=PipelineResponse)
async def update_pipeline(
    pid: int,
    body: PipelineUpdate,
    db: AsyncSession = Depends(get_db),
):
    pipeline = await db.get(ETLPipeline, pid)
    if not pipeline:
        raise HTTPException(status_code=404, detail="Pipeline not found")
    update_data = body.model_dump(exclude_none=True)
    for k, v in update_data.items():
        if hasattr(v, "model_dump"):
            v = v.model_dump()
        setattr(pipeline, k, v)
    pipeline.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(pipeline)
    resp = PipelineResponse.model_validate(pipeline)
    count_q = await db.execute(select(func.count()).where(ETLRun.pipeline_id == pid))
    resp.total_runs = count_q.scalar_one()
    return resp


@router.delete("/pipelines/{pid}", status_code=204)
async def delete_pipeline(pid: int, db: AsyncSession = Depends(get_db)):
    pipeline = await db.get(ETLPipeline, pid)
    if not pipeline:
        raise HTTPException(status_code=404, detail="Pipeline not found")
    await db.delete(pipeline)
    await db.commit()


# ─────────────────────────────────────────────────────────────────────────────
# Run management
# ─────────────────────────────────────────────────────────────────────────────
@router.post("/pipelines/{pid}/run", response_model=RunSummary, status_code=202)
async def trigger_run(
    pid: int,
    body: RunTrigger = RunTrigger(),
    db: AsyncSession = Depends(get_db),
):
    pipeline = await db.get(ETLPipeline, pid)
    if not pipeline:
        raise HTTPException(status_code=404, detail="Pipeline not found")
    if pipeline.status == PipelineStatus.INACTIVE:
        raise HTTPException(status_code=400, detail="Pipeline is inactive")

    from app.schemas.etl import ExtractConfig, TransformConfig, LoadConfig
    extract_cfg = body.extract_config or ExtractConfig(**(pipeline.extract_config or {}))
    # Always merge canvas node configuration on top — canvas is source of truth
    extract_cfg = await _apply_canvas_to_extract_cfg(pipeline, extract_cfg, db)
    transform_cfg = TransformConfig(**(pipeline.transform_config or {}))
    load_cfg = LoadConfig(**(pipeline.load_config or {}))

    ctx = await db.get(ExecutionContext, 1)
    platform_date = ctx.business_date if ctx else None
    resolved_date = body.business_date or platform_date

    if not resolved_date:
        raise HTTPException(status_code=400, detail="No business date set. Set one on the execution context bar before running.")

    # Make namespace_db available for any spark_table target, but do NOT force
    # the target to spark_table — respect the pipeline's configured load target.
    date_compact = resolved_date.replace("-", "")
    namespace_db = f"{_resolve_ns_prefix(ctx)}{date_compact}"
    if load_cfg.namespace_db is None:
        load_cfg = load_cfg.model_copy(update={"namespace_db": namespace_db})

    # Populate job_name from the pipeline name if not already set in extract config.
    if not extract_cfg.job_name:
        extract_cfg = extract_cfg.model_copy(update={"job_name": _pipeline_to_job_name(pipeline.name)})

    run = ETLRun(
        pipeline_id=pid,
        status=RunStatus.PENDING,
        triggered_by="manual",
    )
    db.add(run)
    await db.commit()
    await db.refresh(run)

    # Launch background task
    from app.core.database import AsyncSessionLocal
    _resolved_date = resolved_date  # capture for closure

    async def _bg():
        async with AsyncSessionLocal() as bg_db:
            bg_run = await bg_db.get(ETLRun, run.id)
            await execute_pipeline(bg_db, bg_run, extract_cfg, transform_cfg, load_cfg, business_date=_resolved_date)

    asyncio.create_task(_bg())
    return RunSummary.model_validate(run)


@router.get("/pipelines/{pid}/runs", response_model=list[RunSummary])
async def list_pipeline_runs(
    pid: int,
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(ETLRun)
        .where(ETLRun.pipeline_id == pid)
        .order_by(desc(ETLRun.created_at))
        .limit(limit)
        .offset(offset)
    )
    return [RunSummary.model_validate(r) for r in result.scalars()]


@router.get("/runs", response_model=list[RunSummary])
async def list_all_runs(
    limit: int = Query(default=50, ge=1, le=200),
    status: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    q = select(ETLRun).order_by(desc(ETLRun.created_at)).limit(limit)
    if status:
        q = q.where(ETLRun.status == status)
    result = await db.execute(q)
    return [RunSummary.model_validate(r) for r in result.scalars()]


@router.get("/runs/{run_id}", response_model=RunDetail)
async def get_run(run_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(ETLRun)
        .where(ETLRun.id == run_id)
        .options(
            selectinload(ETLRun.logs),
            selectinload(ETLRun.extract_jobs),
            selectinload(ETLRun.steps),
        )
    )
    run = result.scalar_one_or_none()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    return RunDetail.model_validate(run)


@router.post("/runs/{run_id}/cancel", status_code=202)
async def cancel_run_endpoint(run_id: int, db: AsyncSession = Depends(get_db)):
    cancelled = await cancel_run(run_id)
    if not cancelled:
        raise HTTPException(
            status_code=400,
            detail="Run not active or already completed",
        )
    return {"message": f"Cancellation requested for run {run_id}"}


@router.post("/runs/{run_id}/retry-spark-load", status_code=202)
async def retry_spark_load(run_id: int, db: AsyncSession = Depends(get_db)):
    """Re-attempt Spark catalog table registration for a completed_with_warnings run."""
    result = await db.execute(
        select(ETLRun)
        .where(ETLRun.id == run_id)
        .options(selectinload(ETLRun.extract_jobs))
    )
    run = result.scalar_one_or_none()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    if run.status != RunStatus.COMPLETED_WITH_WARNINGS:
        raise HTTPException(
            status_code=400,
            detail="Only completed_with_warnings runs can have their Spark load retried",
        )

    metadata = run.run_metadata or {}
    job_name = metadata.get("job_name")
    namespace_db = metadata.get("namespace_db")
    table_name = metadata.get("table_name")
    mode = metadata.get("mode", "overwrite")

    if not job_name or not namespace_db:
        raise HTTPException(
            status_code=400,
            detail="Run is missing retry metadata (job_name / namespace_db). Re-run the full pipeline.",
        )

    # Collect unique (app_id, date) pairs from extract jobs
    app_date_pairs = list({(j.application_id, j.date) for j in run.extract_jobs if j.status == RunStatus.COMPLETED})
    if not app_date_pairs:
        raise HTTPException(status_code=400, detail="No completed extract jobs found for this run")

    run.status = RunStatus.RUNNING
    run.error_message = None
    await db.commit()

    from app.core.database import AsyncSessionLocal
    from app.services import spark_service

    async def _bg():
        async with AsyncSessionLocal() as bg_db:
            bg_run = await bg_db.get(ETLRun, run_id)
            errors: list[str] = []
            for app_id, date_str in app_date_pairs:
                try:
                    tbl = await spark_service.merge_and_register_table(
                        app_id, date_str,
                        job_name=job_name,
                        table_name=table_name,
                        namespace_db=namespace_db,
                        mode=mode,
                    )
                    logger.info("Retry spark load: registered %s", tbl)
                except Exception as exc:
                    logger.warning("Retry spark load failed app=%s date=%s: %s", app_id, date_str, exc)
                    errors.append(f"app={app_id} date={date_str}: {exc}")
            if errors:
                bg_run.status = RunStatus.COMPLETED_WITH_WARNINGS
                bg_run.error_message = "Spark table registration failed: " + "; ".join(errors)
            else:
                bg_run.status = RunStatus.COMPLETED
                bg_run.error_message = None
            await bg_db.commit()

    asyncio.create_task(_bg())
    return {"message": "Spark table load retry initiated"}


@router.delete("/runs/{run_id}", status_code=204)
async def delete_run(run_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(ETLRun).where(ETLRun.id == run_id))
    run = result.scalar_one_or_none()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    if run.status in (RunStatus.RUNNING, RunStatus.PENDING):
        raise HTTPException(status_code=409, detail="Cannot delete an active run. Cancel it first.")
    await db.delete(run)
    await db.commit()


@router.delete("/runs", status_code=200)
async def clear_run_history(
    pipeline_id: Optional[int] = Query(None),
    db: AsyncSession = Depends(get_db),
):
    """Delete all non-active runs, optionally scoped to a pipeline."""
    q = select(ETLRun).where(ETLRun.status.not_in([RunStatus.RUNNING, RunStatus.PENDING]))
    if pipeline_id is not None:
        q = q.where(ETLRun.pipeline_id == pipeline_id)
    result = await db.execute(q)
    runs = result.scalars().all()
    count = len(runs)
    for run in runs:
        await db.delete(run)
    await db.commit()
    return {"deleted": count}


# ─────────────────────────────────────────────────────────────────────────────
# SQL Files
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/sql-version-labels", response_model=SqlVersionLabelsResponse)
async def get_sql_version_labels():
    return SqlVersionLabelsResponse(labels=_read_sql_version_labels())


@router.put("/sql-version-labels", response_model=SqlVersionLabelsResponse)
async def update_sql_version_labels(body: SqlVersionLabelsUpdate):
    return SqlVersionLabelsResponse(labels=_write_sql_version_labels(body.labels))

@router.get("/sql-files", response_model=list[SqlFileResponse])
async def list_sql_files(
    file_type: Optional[str] = Query(None, description="'extract' or 'transform'"),
    db: AsyncSession = Depends(get_db),
):
    q = select(SqlFile).options(selectinload(SqlFile.versions)).order_by(SqlFile.name)
    if file_type:
        q = q.where(SqlFile.file_type == file_type)
    result = await db.execute(q)
    return [SqlFileResponse.model_validate(f) for f in result.scalars()]


@router.post("/sql-files", response_model=SqlFileResponse, status_code=201)
async def create_sql_file(body: SqlFileCreate, db: AsyncSession = Depends(get_db)):
    sql_file = SqlFile(
        name=body.name,
        description=body.description,
        file_type=body.file_type,
        content=body.content,
    )
    db.add(sql_file)
    await db.flush()

    initial_tag = _read_sql_version_labels()[0]
    db.add(SqlFileVersion(
        sql_file_id=sql_file.id,
        version="v1",
        tag=initial_tag,
        content=sql_file.content,
    ))

    await db.commit()
    await db.refresh(sql_file)
    result2 = await db.execute(
        select(SqlFile).where(SqlFile.id == sql_file.id).options(selectinload(SqlFile.versions))
    )
    sql_file = result2.scalar_one()
    # Sync to disk
    await asyncio.to_thread(_sql_path(sql_file.name, sql_file.file_type).write_text, sql_file.content, "utf-8")
    return SqlFileResponse.model_validate(sql_file)


@router.put("/sql-files/{fid}", response_model=SqlFileResponse)
async def update_sql_file(
    fid: int,
    body: SqlFileUpdate,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(SqlFile).where(SqlFile.id == fid).options(selectinload(SqlFile.versions))
    )
    sql_file = result.scalar_one_or_none()
    if not sql_file:
        raise HTTPException(status_code=404, detail="SQL file not found")
    old_content = sql_file.content
    old_path = _sql_path(sql_file.name, sql_file.file_type)
    update_data = body.model_dump(exclude_none=True)
    for k, v in update_data.items():
        setattr(sql_file, k, v)

    if body.content is not None and body.content != old_content:
        n = _next_sql_version_number(sql_file)
        db.add(SqlFileVersion(
            sql_file_id=fid,
            version=f"v{n}",
            tag="DRAFT",
            content=body.content,
        ))

    sql_file.updated_at = datetime.now(timezone.utc)
    await db.commit()
    result2 = await db.execute(
        select(SqlFile).where(SqlFile.id == fid).options(selectinload(SqlFile.versions))
    )
    sql_file = result2.scalar_one()
    # Sync to disk — remove old path if name/type changed, write new
    new_path = _sql_path(sql_file.name, sql_file.file_type)
    if old_path != new_path and old_path.exists():
        await asyncio.to_thread(old_path.unlink)
    await asyncio.to_thread(new_path.write_text, sql_file.content, "utf-8")
    return SqlFileResponse.model_validate(sql_file)


@router.post("/sql-files/{fid}/versions", response_model=SqlFileResponse)
async def create_sql_file_version(
    fid: int,
    body: SqlFileVersionCreate,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(SqlFile).where(SqlFile.id == fid).options(selectinload(SqlFile.versions))
    )
    sql_file = result.scalar_one_or_none()
    if not sql_file:
        raise HTTPException(status_code=404, detail="SQL file not found")

    allowed = set(_read_sql_version_labels())
    tag = _normalise_version_label(body.tag or "DRAFT")
    if tag not in allowed:
        raise HTTPException(status_code=400, detail=f"Invalid version label '{tag}'. Allowed: {sorted(allowed)}")

    content = body.content if body.content is not None else sql_file.content
    n = _next_sql_version_number(sql_file)
    db.add(SqlFileVersion(
        sql_file_id=fid,
        version=f"v{n}",
        tag=tag,
        content=content,
    ))

    if body.content is not None and body.content != sql_file.content:
        sql_file.content = body.content
        sql_file.updated_at = datetime.now(timezone.utc)

    await db.commit()
    result2 = await db.execute(
        select(SqlFile).where(SqlFile.id == fid).options(selectinload(SqlFile.versions))
    )
    sql_file = result2.scalar_one()
    await asyncio.to_thread(_sql_path(sql_file.name, sql_file.file_type).write_text, sql_file.content, "utf-8")
    return SqlFileResponse.model_validate(sql_file)


@router.delete("/sql-files/{fid}", status_code=204)
async def delete_sql_file(fid: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(SqlFile).where(SqlFile.id == fid))
    sql_file = result.scalar_one_or_none()
    if not sql_file:
        raise HTTPException(status_code=404, detail="SQL file not found")

    # Canonical path and legacy path (for old double-extension naming) are both cleaned.
    canonical_path = _sql_path(sql_file.name, sql_file.file_type)
    legacy_path = _sql_dir(sql_file.file_type) / f"{sql_file.name.lower()}.sql"

    await db.delete(sql_file)
    await db.commit()

    for path in {canonical_path, legacy_path}:
        if path.exists():
            await asyncio.to_thread(path.unlink)


# ─────────────────────────────────────────────────────────────────────────────
# Pipeline Graph
# ─────────────────────────────────────────────────────────────────────────────
@router.get("/graph", response_model=PipelineGraph)
async def get_pipeline_graph(db: AsyncSession = Depends(get_db)):
    """Return all pipelines as nodes and dependencies as edges."""
    pipelines_result = await db.execute(select(ETLPipeline).order_by(ETLPipeline.id))
    pipelines = pipelines_result.scalars().all()

    deps_result = await db.execute(select(PipelineDependency))
    deps = deps_result.scalars().all()

    # Gather last run status + step statuses per pipeline
    last_run_by_pipeline: dict[int, str] = {}
    step_statuses_by_pipeline: dict[int, dict[str, str]] = {}
    for p in pipelines:
        run_q = await db.execute(
            select(ETLRun)
            .where(ETLRun.pipeline_id == p.id)
            .order_by(desc(ETLRun.created_at))
            .limit(1)
            .options(selectinload(ETLRun.steps))
        )
        last_run = run_q.scalar_one_or_none()
        if last_run:
            last_run_by_pipeline[p.id] = last_run.status
            step_statuses_by_pipeline[p.id] = {
                s.step_type: s.status for s in last_run.steps
            }

    def _app_names(ec: dict) -> list[str]:
        result = []
        for a in (ec.get("apps") or []):
            name = a.get("name") or ""
            app_id = a.get("id") or ""
            label = name if (name and not name.strip().isdigit()) else app_id
            if label:
                result.append(label)
        return result

    nodes = [
        GraphNode(
            id=p.id,
            name=p.name,
            description=p.description,
            status=p.status,
            source_type=(p.extract_config or {}).get("source_type", "datawarehouse"),
            last_run_status=last_run_by_pipeline.get(p.id),
            app_names=_app_names(p.extract_config or {}),
            load_target=(p.load_config or {}).get("target", "parquet"),
            load_table_name=(p.load_config or {}).get("table_name"),
            last_run_step_statuses=step_statuses_by_pipeline.get(p.id, {}),
        )
        for p in pipelines
    ]
    edges = [
        GraphEdge(id=f"dep-{d.id}", source=d.upstream_id, target=d.pipeline_id, dependency_id=d.id)
        for d in deps
    ]
    return PipelineGraph(nodes=nodes, edges=edges)


# ─────────────────────────────────────────────────────────────────────────────
# Execution context (platform-wide business date + namespace)
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/context", response_model=ExecutionContextResponse)
async def get_execution_context(db: AsyncSession = Depends(get_db)):
    ctx = await db.get(ExecutionContext, 1)
    if not ctx:
        ctx = ExecutionContext(id=1, business_date=None, namespace_prefix="")
        db.add(ctx)
        await db.commit()
        await db.refresh(ctx)
    return _build_context_response(ctx)


@router.put("/context", response_model=ExecutionContextResponse)
async def update_execution_context(
    body: ExecutionContextUpdate,
    db: AsyncSession = Depends(get_db),
):
    ctx = await db.get(ExecutionContext, 1)
    if not ctx:
        ctx = ExecutionContext(id=1, business_date=None, namespace_prefix="")
        db.add(ctx)
    if body.business_date is not None:
        ctx.business_date = body.business_date or None  # empty string → clear
    if body.namespace_prefix is not None:
        ctx.namespace_prefix = body.namespace_prefix
    if body.db_name is not None:
        ctx.db_name = body.db_name or None  # empty string → clear
    ctx.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(ctx)
    return _build_context_response(ctx)
