"""Transform & Load API routes."""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db, AsyncSessionLocal
from app.models.etl import NotebookFile, TransformJob, TransformJobStatus, SqlFile
from app.schemas.etl import (
    NotebookFileCreate, NotebookFileUpdate, NotebookFileResponse,
    NotebookCell,
    TransformJobCreate, TransformJobUpdate, TransformJobResponse,
)
from app.services.spark_service import spark_service

router = APIRouter(prefix="/transform", tags=["Transform"])
logger = logging.getLogger(__name__)


# ─── Preview (dry-run) ────────────────────────────────────────────────────────

class PreviewRequest(BaseModel):
    source_database: Optional[str] = None
    source_table: str
    transform_type: str = "sql"
    sql_content: Optional[str] = None
    cells: Optional[list[NotebookCell]] = None
    limit: int = 100


@router.post("/preview")
async def preview_transform(body: PreviewRequest):
    """Dry-run a SQL or notebook transform and return a preview of result rows.
    Nothing is written to any target table.
    """
    cells_raw = [c.model_dump() for c in body.cells] if body.cells else None
    try:
        result = await spark_service.preview_transform(
            source_db=body.source_database,
            source_table=body.source_table,
            transform_type=body.transform_type,
            sql=body.sql_content,
            cells=cells_raw,
            limit=body.limit,
        )
        return result
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))

# ─── Notebook Files ───────────────────────────────────────────────────────────

@router.get("/notebooks", response_model=list[NotebookFileResponse])
async def list_notebooks(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(NotebookFile).order_by(NotebookFile.name))
    return [NotebookFileResponse.model_validate(n) for n in result.scalars()]


@router.post("/notebooks", response_model=NotebookFileResponse, status_code=201)
async def create_notebook(body: NotebookFileCreate, db: AsyncSession = Depends(get_db)):
    nb = NotebookFile(
        name=body.name,
        description=body.description,
        cells=[c.model_dump() for c in body.cells],
    )
    db.add(nb)
    await db.commit()
    await db.refresh(nb)
    return NotebookFileResponse.model_validate(nb)


@router.get("/notebooks/{nb_id}", response_model=NotebookFileResponse)
async def get_notebook(nb_id: int, db: AsyncSession = Depends(get_db)):
    nb = await db.get(NotebookFile, nb_id)
    if not nb:
        raise HTTPException(status_code=404, detail="Notebook not found")
    return NotebookFileResponse.model_validate(nb)


@router.put("/notebooks/{nb_id}", response_model=NotebookFileResponse)
async def update_notebook(nb_id: int, body: NotebookFileUpdate, db: AsyncSession = Depends(get_db)):
    nb = await db.get(NotebookFile, nb_id)
    if not nb:
        raise HTTPException(status_code=404, detail="Notebook not found")
    if body.name is not None:
        nb.name = body.name
    if body.description is not None:
        nb.description = body.description
    if body.cells is not None:
        nb.cells = [c.model_dump() for c in body.cells]
    await db.commit()
    await db.refresh(nb)
    return NotebookFileResponse.model_validate(nb)


@router.delete("/notebooks/{nb_id}", status_code=204)
async def delete_notebook(nb_id: int, db: AsyncSession = Depends(get_db)):
    nb = await db.get(NotebookFile, nb_id)
    if not nb:
        raise HTTPException(status_code=404, detail="Notebook not found")
    await db.delete(nb)
    await db.commit()


# ─── Transform Jobs ───────────────────────────────────────────────────────────

def _to_response(job: TransformJob) -> TransformJobResponse:
    data = TransformJobResponse.model_validate(job)
    if job.sql_file:
        data.sql_file_name = job.sql_file.name
    if job.notebook_file:
        data.notebook_file_name = job.notebook_file.name
    return data


@router.get("/jobs", response_model=list[TransformJobResponse])
async def list_transform_jobs(db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(TransformJob).order_by(TransformJob.name)
    )
    jobs = result.scalars().all()
    # Eager-load sql_file / notebook_file names
    for job in jobs:
        if job.sql_file_id:
            sf = await db.get(SqlFile, job.sql_file_id)
            job.sql_file = sf
        if job.notebook_file_id:
            nb = await db.get(NotebookFile, job.notebook_file_id)
            job.notebook_file = nb
    return [_to_response(j) for j in jobs]


@router.post("/jobs", response_model=TransformJobResponse, status_code=201)
async def create_transform_job(body: TransformJobCreate, db: AsyncSession = Depends(get_db)):
    job = TransformJob(**body.model_dump())
    db.add(job)
    await db.commit()
    await db.refresh(job)
    return TransformJobResponse.model_validate(job)


@router.get("/jobs/{job_id}", response_model=TransformJobResponse)
async def get_transform_job(job_id: int, db: AsyncSession = Depends(get_db)):
    job = await db.get(TransformJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Transform job not found")
    if job.sql_file_id:
        job.sql_file = await db.get(SqlFile, job.sql_file_id)
    if job.notebook_file_id:
        job.notebook_file = await db.get(NotebookFile, job.notebook_file_id)
    return _to_response(job)


@router.put("/jobs/{job_id}", response_model=TransformJobResponse)
async def update_transform_job(job_id: int, body: TransformJobUpdate, db: AsyncSession = Depends(get_db)):
    job = await db.get(TransformJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Transform job not found")
    for field, val in body.model_dump(exclude_unset=True).items():
        setattr(job, field, val)
    await db.commit()
    await db.refresh(job)
    return TransformJobResponse.model_validate(job)


@router.delete("/jobs/{job_id}", status_code=204)
async def delete_transform_job(job_id: int, db: AsyncSession = Depends(get_db)):
    job = await db.get(TransformJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Transform job not found")
    await db.delete(job)
    await db.commit()


@router.post("/jobs/{job_id}/run", response_model=TransformJobResponse)
async def run_transform_job(
    job_id: int,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    job = await db.get(TransformJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Transform job not found")
    if job.status == TransformJobStatus.RUNNING:
        raise HTTPException(status_code=409, detail="Job is already running")

    # Resolve SQL content
    sql_content = job.sql_content
    notebook_cells: list[dict] = []

    if job.transform_type == "sql":
        if not sql_content and job.sql_file_id:
            sf = await db.get(SqlFile, job.sql_file_id)
            if sf:
                sql_content = sf.content
        if not sql_content:
            raise HTTPException(status_code=422, detail="No SQL content configured for this job")
    elif job.transform_type == "notebook":
        if job.notebook_file_id:
            nb = await db.get(NotebookFile, job.notebook_file_id)
            if nb:
                notebook_cells = nb.cells or []
        if not notebook_cells:
            raise HTTPException(status_code=422, detail="No notebook configured for this job")

    # Mark running
    job.status = TransformJobStatus.RUNNING
    await db.commit()

    async def _execute():
        async with AsyncSessionLocal() as session:
            j = await session.get(TransformJob, job_id)
            if not j:
                return
            try:
                if j.transform_type == "sql":
                    result = await spark_service.run_sql_transform(
                        source_db=j.source_database,
                        source_table=j.source_table,
                        sql=sql_content,
                        target_db=j.target_database,
                        target_table=j.target_table,
                        mode=j.target_mode or "overwrite",
                    )
                else:
                    result = await spark_service.run_notebook_transform(
                        source_db=j.source_database,
                        source_table=j.source_table,
                        cells=notebook_cells,
                        target_db=j.target_database,
                        target_table=j.target_table,
                        mode=j.target_mode or "overwrite",
                    )
                j.status = TransformJobStatus.COMPLETED
                j.last_run_at = datetime.now(timezone.utc)
                j.last_run_duration_s = result["duration_s"]
                j.last_run_rows = result["row_count"]
                j.last_error = None
            except Exception as exc:
                logger.exception("Transform job %d failed", job_id)
                j.status = TransformJobStatus.FAILED
                j.last_run_at = datetime.now(timezone.utc)
                j.last_error = str(exc)
            await session.commit()

    background_tasks.add_task(_execute)
    return TransformJobResponse.model_validate(job)


@router.post("/jobs/{job_id}/cancel", response_model=TransformJobResponse)
async def cancel_transform_job(job_id: int, db: AsyncSession = Depends(get_db)):
    """Mark a running job as failed/cancelled. The background task will still finish
    its current Spark operation, but the status is updated immediately so the UI
    reflects cancellation and the job won't be picked up again."""
    job = await db.get(TransformJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Transform job not found")
    if job.status != TransformJobStatus.RUNNING:
        raise HTTPException(status_code=409, detail="Job is not running")
    job.status = TransformJobStatus.FAILED
    job.last_error = "Cancelled by user"
    job.last_run_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(job)
    return TransformJobResponse.model_validate(job)


# ─── ETL Chains ───────────────────────────────────────────────────────────────

from app.models.etl import ETLChain, ETLChainStatus  # noqa: E402
from app.schemas.etl import ETLChainCreate, ETLChainUpdate, ETLChainResponse, ChainStep  # noqa: E402


def _chain_response(chain: ETLChain, pipelines: dict, jobs: dict) -> ETLChainResponse:
    """Build a response, setting display labels on each step."""
    steps_with_labels = []
    for raw in (chain.steps or []):
        step = ChainStep(**raw) if isinstance(raw, dict) else raw
        if step.type == "pipeline" and step.pipeline_id in pipelines:
            step = step.model_copy(update={"label": pipelines[step.pipeline_id]})
        elif step.type == "transform" and step.transform_job_id in jobs:
            step = step.model_copy(update={"label": jobs[step.transform_job_id]})
        steps_with_labels.append(step)
    resp = ETLChainResponse.model_validate(chain)
    resp.steps = steps_with_labels
    return resp


async def _load_name_maps(db: AsyncSession) -> tuple[dict[int, str], dict[int, str]]:
    from app.models.etl import ETLPipeline
    pipelines = {p.id: p.name for p in (await db.execute(select(ETLPipeline))).scalars()}
    jobs = {j.id: j.name for j in (await db.execute(select(TransformJob))).scalars()}
    return pipelines, jobs


@router.get("/chains", response_model=list[ETLChainResponse])
async def list_chains(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(ETLChain).order_by(ETLChain.name))
    chains = result.scalars().all()
    pipelines, jobs = await _load_name_maps(db)
    return [_chain_response(c, pipelines, jobs) for c in chains]


@router.post("/chains", response_model=ETLChainResponse, status_code=201)
async def create_chain(body: ETLChainCreate, db: AsyncSession = Depends(get_db)):
    chain = ETLChain(
        name=body.name,
        description=body.description,
        steps=[s.model_dump() for s in body.steps],
    )
    db.add(chain)
    await db.commit()
    await db.refresh(chain)
    pipelines, jobs = await _load_name_maps(db)
    return _chain_response(chain, pipelines, jobs)


@router.get("/chains/{chain_id}", response_model=ETLChainResponse)
async def get_chain(chain_id: int, db: AsyncSession = Depends(get_db)):
    chain = await db.get(ETLChain, chain_id)
    if not chain:
        raise HTTPException(status_code=404, detail="Chain not found")
    pipelines, jobs = await _load_name_maps(db)
    return _chain_response(chain, pipelines, jobs)


@router.put("/chains/{chain_id}", response_model=ETLChainResponse)
async def update_chain(chain_id: int, body: ETLChainUpdate, db: AsyncSession = Depends(get_db)):
    chain = await db.get(ETLChain, chain_id)
    if not chain:
        raise HTTPException(status_code=404, detail="Chain not found")
    if body.name is not None:
        chain.name = body.name
    if body.description is not None:
        chain.description = body.description
    if body.steps is not None:
        chain.steps = [s.model_dump() for s in body.steps]
    await db.commit()
    await db.refresh(chain)
    pipelines, jobs = await _load_name_maps(db)
    return _chain_response(chain, pipelines, jobs)


@router.delete("/chains/{chain_id}", status_code=204)
async def delete_chain(chain_id: int, db: AsyncSession = Depends(get_db)):
    chain = await db.get(ETLChain, chain_id)
    if not chain:
        raise HTTPException(status_code=404, detail="Chain not found")
    await db.delete(chain)
    await db.commit()


@router.post("/chains/{chain_id}/run", response_model=ETLChainResponse)
async def run_chain(
    chain_id: int,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    chain = await db.get(ETLChain, chain_id)
    if not chain:
        raise HTTPException(status_code=404, detail="Chain not found")
    if chain.status == ETLChainStatus.RUNNING:
        raise HTTPException(status_code=409, detail="Chain is already running")

    steps_snapshot = list(chain.steps or [])
    chain.status = ETLChainStatus.RUNNING
    await db.commit()

    async def _run_chain():
        import time as _time
        t0 = _time.perf_counter()
        async with AsyncSessionLocal() as session:
            c = await session.get(ETLChain, chain_id)
            if not c:
                return
            try:
                for raw_step in steps_snapshot:
                    step = ChainStep(**raw_step) if isinstance(raw_step, dict) else raw_step
                    if step.type == "pipeline" and step.pipeline_id:
                        await _run_pipeline_step(session, step.pipeline_id)
                    elif step.type == "transform" and step.transform_job_id:
                        await _run_transform_step(session, step.transform_job_id)
                c.status = ETLChainStatus.COMPLETED
                c.last_error = None
            except Exception as exc:
                logger.exception("Chain %d failed", chain_id)
                c.status = ETLChainStatus.FAILED
                c.last_error = str(exc)
            finally:
                c.last_run_at = datetime.now(timezone.utc)
                c.last_run_duration_s = round(_time.perf_counter() - t0, 2)
                await session.commit()

    background_tasks.add_task(_run_chain)
    return ETLChainResponse.model_validate(chain)


async def _run_pipeline_step(db: AsyncSession, pipeline_id: int) -> None:
    """Run one ETL pipeline step synchronously (awaits completion)."""
    import asyncio
    from app.models.etl import ETLPipeline, ETLRun, RunStatus, PipelineStatus, ExecutionContext
    from app.schemas.etl import ExtractConfig, TransformConfig, LoadConfig
    from app.services.etl_engine import execute_pipeline

    pipeline = await db.get(ETLPipeline, pipeline_id)
    if not pipeline:
        raise ValueError(f"Pipeline {pipeline_id} not found")
    if pipeline.status == PipelineStatus.INACTIVE:
        raise ValueError(f"Pipeline '{pipeline.name}' is inactive")

    extract_cfg = ExtractConfig(**(pipeline.extract_config or {}))
    transform_cfg = TransformConfig(**(pipeline.transform_config or {}))
    load_cfg = LoadConfig(**(pipeline.load_config or {}))

    ctx = await db.get(ExecutionContext, 1)
    if ctx and ctx.business_date:
        date_compact = ctx.business_date.replace("-", "")
        prefix = ctx.namespace_prefix or "data_"
        load_cfg = load_cfg.model_copy(update={
            "namespace_db": f"{prefix}{date_compact}",
            "target": "spark_table",
        })

    run = ETLRun(pipeline_id=pipeline_id, status=RunStatus.PENDING, triggered_by="chain")
    db.add(run)
    await db.commit()
    await db.refresh(run)

    await execute_pipeline(db, run, extract_cfg, transform_cfg, load_cfg)

    # Refresh to check final status
    await db.refresh(run)
    if run.status == RunStatus.FAILED:
        raise RuntimeError(f"Pipeline '{pipeline.name}' failed: {run.error_message}")


async def _run_transform_step(db: AsyncSession, job_id: int) -> None:
    """Run one transform step synchronously (awaits completion)."""
    job = await db.get(TransformJob, job_id)
    if not job:
        raise ValueError(f"Transform job {job_id} not found")

    sql_content = job.sql_content
    notebook_cells: list[dict] = []

    if job.transform_type == "sql":
        if not sql_content and job.sql_file_id:
            sf = await db.get(SqlFile, job.sql_file_id)
            if sf:
                sql_content = sf.content
        if not sql_content:
            raise ValueError(f"Transform job '{job.name}' has no SQL content")
    else:
        if job.notebook_file_id:
            nb = await db.get(NotebookFile, job.notebook_file_id)
            if nb:
                notebook_cells = nb.cells or []
        if not notebook_cells:
            raise ValueError(f"Transform job '{job.name}' has no notebook cells")

    job.status = TransformJobStatus.RUNNING
    await db.commit()

    try:
        if job.transform_type == "sql":
            result = await spark_service.run_sql_transform(
                source_db=job.source_database,
                source_table=job.source_table,
                sql=sql_content,
                target_db=job.target_database,
                target_table=job.target_table,
                mode=job.target_mode or "overwrite",
            )
        else:
            result = await spark_service.run_notebook_transform(
                source_db=job.source_database,
                source_table=job.source_table,
                cells=notebook_cells,
                target_db=job.target_database,
                target_table=job.target_table,
                mode=job.target_mode or "overwrite",
            )
        job.status = TransformJobStatus.COMPLETED
        job.last_run_at = datetime.now(timezone.utc)
        job.last_run_duration_s = result["duration_s"]
        job.last_run_rows = result["row_count"]
        job.last_error = None
    except Exception as exc:
        job.status = TransformJobStatus.FAILED
        job.last_run_at = datetime.now(timezone.utc)
        job.last_error = str(exc)
        await db.commit()
        raise RuntimeError(f"Transform '{job.name}' failed: {exc}") from exc

    await db.commit()

