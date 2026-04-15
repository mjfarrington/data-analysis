from __future__ import annotations
import asyncio
import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks, Query
from sqlalchemy import select, func, desc
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.database import get_db
from app.models.etl import ETLPipeline, ETLRun, RunStatus, PipelineStatus, SqlFile, PipelineDependency
from app.schemas.etl import (
    PipelineCreate, PipelineUpdate, PipelineResponse,
    RunTrigger, RunSummary, RunDetail,
    SqlFileCreate, SqlFileUpdate, SqlFileResponse,
    DependencyCreate, DependencyResponse, GraphNode, GraphEdge, PipelineGraph,
)
from app.services.etl_engine import execute_pipeline, cancel_run, get_active_run_ids
from app.services.grpc_client import grpc_client

router = APIRouter(prefix="/etl", tags=["ETL"])
logger = logging.getLogger(__name__)


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


@router.post("/pipelines", response_model=PipelineResponse, status_code=201)
async def create_pipeline(
    body: PipelineCreate,
    db: AsyncSession = Depends(get_db),
):
    pipeline = ETLPipeline(
        name=body.name,
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


@router.get("/pipelines/{pid}", response_model=PipelineResponse)
async def get_pipeline(pid: int, db: AsyncSession = Depends(get_db)):
    pipeline = await db.get(ETLPipeline, pid)
    if not pipeline:
        raise HTTPException(status_code=404, detail="Pipeline not found")
    runs_q = await db.execute(
        select(ETLRun).where(ETLRun.pipeline_id == pid)
        .order_by(desc(ETLRun.created_at)).limit(1)
    )
    last_run = runs_q.scalar_one_or_none()
    count_q = await db.execute(select(func.count()).where(ETLRun.pipeline_id == pid))
    total = count_q.scalar_one()
    resp = PipelineResponse.model_validate(pipeline)
    resp.last_run = RunSummary.model_validate(last_run) if last_run else None
    resp.total_runs = total
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
    transform_cfg = TransformConfig(**(pipeline.transform_config or {}))
    load_cfg = LoadConfig(**(pipeline.load_config or {}))

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
    async def _bg():
        async with AsyncSessionLocal() as bg_db:
            bg_run = await bg_db.get(ETLRun, run.id)
            await execute_pipeline(bg_db, bg_run, extract_cfg, transform_cfg, load_cfg)

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
    runs = result.scalars().all()
    out = []
    for r in runs:
        s = RunSummary.model_validate(r)
        # Enrich with pipeline name
        out.append(s)
    return out


@router.get("/runs/{run_id}", response_model=RunDetail)
async def get_run(run_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(ETLRun)
        .where(ETLRun.id == run_id)
        .options(
            selectinload(ETLRun.logs),
            selectinload(ETLRun.extract_jobs),
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


@router.get("/active", response_model=list[int])
async def get_active_runs():
    return get_active_run_ids()


# ─────────────────────────────────────────────────────────────────────────────
# gRPC Data Source
# ─────────────────────────────────────────────────────────────────────────────
@router.get("/sources/available")
async def list_available_sources(
    application_id: Optional[str] = None,
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
):
    return await grpc_client.list_available_data(
        application_id=application_id or "",
        from_date=from_date or "",
        to_date=to_date or "",
    )


# ─────────────────────────────────────────────────────────────────────────────
# SQL Files
# ─────────────────────────────────────────────────────────────────────────────
@router.get("/sql-files", response_model=list[SqlFileResponse])
async def list_sql_files(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(SqlFile).order_by(SqlFile.name))
    return [SqlFileResponse.model_validate(f) for f in result.scalars()]


@router.post("/sql-files", response_model=SqlFileResponse, status_code=201)
async def create_sql_file(body: SqlFileCreate, db: AsyncSession = Depends(get_db)):
    sql_file = SqlFile(
        name=body.name,
        description=body.description,
        content=body.content,
    )
    db.add(sql_file)
    await db.commit()
    await db.refresh(sql_file)
    return SqlFileResponse.model_validate(sql_file)


@router.get("/sql-files/{fid}", response_model=SqlFileResponse)
async def get_sql_file(fid: int, db: AsyncSession = Depends(get_db)):
    sql_file = await db.get(SqlFile, fid)
    if not sql_file:
        raise HTTPException(status_code=404, detail="SQL file not found")
    return SqlFileResponse.model_validate(sql_file)


@router.put("/sql-files/{fid}", response_model=SqlFileResponse)
async def update_sql_file(
    fid: int,
    body: SqlFileUpdate,
    db: AsyncSession = Depends(get_db),
):
    sql_file = await db.get(SqlFile, fid)
    if not sql_file:
        raise HTTPException(status_code=404, detail="SQL file not found")
    update_data = body.model_dump(exclude_none=True)
    for k, v in update_data.items():
        setattr(sql_file, k, v)
    sql_file.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(sql_file)
    return SqlFileResponse.model_validate(sql_file)


@router.delete("/sql-files/{fid}", status_code=204)
async def delete_sql_file(fid: int, db: AsyncSession = Depends(get_db)):
    sql_file = await db.get(SqlFile, fid)
    if not sql_file:
        raise HTTPException(status_code=404, detail="SQL file not found")
    await db.delete(sql_file)
    await db.commit()


# ─────────────────────────────────────────────────────────────────────────────
# Pipeline Dependencies
# ─────────────────────────────────────────────────────────────────────────────
@router.get("/graph", response_model=PipelineGraph)
async def get_pipeline_graph(db: AsyncSession = Depends(get_db)):
    """Return all pipelines as nodes and dependencies as edges."""
    pipelines_result = await db.execute(select(ETLPipeline).order_by(ETLPipeline.id))
    pipelines = pipelines_result.scalars().all()

    deps_result = await db.execute(select(PipelineDependency))
    deps = deps_result.scalars().all()

    # Gather last run status per pipeline
    last_run_by_pipeline: dict[int, str] = {}
    for p in pipelines:
        run_q = await db.execute(
            select(ETLRun)
            .where(ETLRun.pipeline_id == p.id)
            .order_by(desc(ETLRun.created_at))
            .limit(1)
        )
        last_run = run_q.scalar_one_or_none()
        if last_run:
            last_run_by_pipeline[p.id] = last_run.status

    nodes = [
        GraphNode(
            id=p.id,
            name=p.name,
            description=p.description,
            status=p.status,
            source_type=(p.extract_config or {}).get("source_type", "grpc"),
            last_run_status=last_run_by_pipeline.get(p.id),
        )
        for p in pipelines
    ]
    edges = [
        GraphEdge(id=f"dep-{d.id}", source=d.upstream_id, target=d.pipeline_id, dependency_id=d.id)
        for d in deps
    ]
    return PipelineGraph(nodes=nodes, edges=edges)


@router.get("/pipelines/{pid}/dependencies", response_model=list[DependencyResponse])
async def list_dependencies(pid: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(PipelineDependency).where(PipelineDependency.pipeline_id == pid)
    )
    return [DependencyResponse.model_validate(d) for d in result.scalars()]


@router.post("/pipelines/{pid}/dependencies", response_model=DependencyResponse, status_code=201)
async def add_dependency(
    pid: int,
    body: DependencyCreate,
    db: AsyncSession = Depends(get_db),
):
    if body.upstream_id == pid:
        raise HTTPException(status_code=400, detail="A pipeline cannot depend on itself")

    # Check both pipelines exist
    if not await db.get(ETLPipeline, pid):
        raise HTTPException(status_code=404, detail="Pipeline not found")
    if not await db.get(ETLPipeline, body.upstream_id):
        raise HTTPException(status_code=404, detail="Upstream pipeline not found")

    # Check for duplicate
    existing = await db.execute(
        select(PipelineDependency).where(
            PipelineDependency.pipeline_id == pid,
            PipelineDependency.upstream_id == body.upstream_id,
        )
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Dependency already exists")

    # Simple cycle check: upstream must not already depend on pid (direct only)
    reverse = await db.execute(
        select(PipelineDependency).where(
            PipelineDependency.pipeline_id == body.upstream_id,
            PipelineDependency.upstream_id == pid,
        )
    )
    if reverse.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Adding this dependency would create a cycle")

    dep = PipelineDependency(pipeline_id=pid, upstream_id=body.upstream_id)
    db.add(dep)
    await db.commit()
    await db.refresh(dep)
    return DependencyResponse.model_validate(dep)


@router.delete("/pipelines/{pid}/dependencies/{dep_id}", status_code=204)
async def remove_dependency(pid: int, dep_id: int, db: AsyncSession = Depends(get_db)):
    dep = await db.get(PipelineDependency, dep_id)
    if not dep or dep.pipeline_id != pid:
        raise HTTPException(status_code=404, detail="Dependency not found")
    await db.delete(dep)
    await db.commit()
