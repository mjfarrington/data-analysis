"""
Admin endpoints — destructive / management operations.
All writes are intentional and scoped to non-running data.
"""
from __future__ import annotations

import asyncio
import logging
import shutil
import subprocess
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Body
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db
from app.models.etl import ETLRun, RunStatus, ServiceError

router = APIRouter(prefix="/admin", tags=["Admin"])
logger = logging.getLogger(__name__)

# ─── Schemas ──────────────────────────────────────────────────────────────────

class StorageNode(BaseModel):
    path: str
    name: str
    size_bytes: int
    children: list["StorageNode"] = []
    is_dir: bool

StorageNode.model_rebuild()

class StorageTree(BaseModel):
    nodes: list[StorageNode]
    total_bytes: int

class BulkRunsDelete(BaseModel):
    ids: Optional[list[int]] = None   # None = clear all completed/failed
    statuses: Optional[list[str]] = None  # if ids is None, filter by status

class AdminResult(BaseModel):
    ok: bool
    message: str
    affected: int = 0

class ServiceRestartResult(BaseModel):
    service: str
    ok: bool
    message: str

# ─── Helpers ──────────────────────────────────────────────────────────────────

def _dir_size(p: Path) -> int:
    if not p.exists():
        return 0
    if p.is_file():
        return p.stat().st_size
    return sum(f.stat().st_size for f in p.rglob("*") if f.is_file())


def _build_node(path: Path, depth: int = 3) -> StorageNode:
    size = _dir_size(path)
    node = StorageNode(path=str(path), name=path.name, size_bytes=size, is_dir=path.is_dir())
    if path.is_dir() and depth > 0:
        try:
            children = sorted(path.iterdir(), key=lambda p: (-_dir_size(p), p.name))
            node.children = [_build_node(c, depth - 1) for c in children[:50]]
        except PermissionError:
            pass
    return node


# ─── Storage tree ─────────────────────────────────────────────────────────────

@router.get("/storage", response_model=StorageTree)
async def get_storage_tree():
    """Return a tree of data directories with sizes."""
    roots = [
        Path(settings.PIPELINE_DIR),
        Path(settings.STATIC_DIR),
        Path(settings.SPARK_EVENTS_DIR),
    ]
    nodes = [_build_node(r) for r in roots if r.exists()]
    total = sum(n.size_bytes for n in nodes)
    return StorageTree(nodes=nodes, total_bytes=total)


@router.delete("/storage/path", response_model=AdminResult)
async def purge_storage_path(path: str = Body(..., embed=True)):
    """
    Delete a single file or directory under DATA_DIR.
    Path must be inside DATA_DIR to prevent traversal.
    """
    data_root = Path(settings.DATA_DIR).resolve()
    target = Path(path).resolve()
    if not str(target).startswith(str(data_root)):
        raise HTTPException(status_code=400, detail="Path is outside DATA_DIR")
    if not target.exists():
        raise HTTPException(status_code=404, detail="Path not found")

    if target.is_dir():
        size = _dir_size(target)
        shutil.rmtree(target)
        return AdminResult(ok=True, message=f"Deleted directory {target.name}", affected=size)
    else:
        size = target.stat().st_size
        target.unlink()
        return AdminResult(ok=True, message=f"Deleted file {target.name}", affected=size)


@router.delete("/storage/all", response_model=AdminResult)
async def purge_all_storage():
    """Purge ALL pipeline data (extracts + parquet). Static SQL and sources are never touched."""
    pipeline_root = Path(settings.PIPELINE_DIR)
    total_bytes = _dir_size(pipeline_root)
    if pipeline_root.exists():
        shutil.rmtree(pipeline_root)
    pipeline_root.mkdir(parents=True, exist_ok=True)
    return AdminResult(ok=True, message="All pipeline data purged", affected=total_bytes)


# ─── Runs management ──────────────────────────────────────────────────────────

TERMINAL_STATUSES = {RunStatus.COMPLETED, RunStatus.FAILED, RunStatus.CANCELLED}

@router.delete("/runs", response_model=AdminResult)
async def delete_runs(
    body: BulkRunsDelete = Body(default_factory=BulkRunsDelete),
    db: AsyncSession = Depends(get_db),
):
    """
    Delete run records.
    - ids provided → delete exactly those runs (only if not running/pending)
    - ids=None → delete all completed/failed/cancelled runs
    """
    if body.ids is not None:
        # Explicit IDs — refuse to delete active runs
        rows = await db.execute(
            select(ETLRun).where(ETLRun.id.in_(body.ids))
        )
        runs = rows.scalars().all()
        active = [r.id for r in runs if r.status not in TERMINAL_STATUSES]
        if active:
            raise HTTPException(
                status_code=409,
                detail=f"Cannot delete active runs: {active}",
            )
        for r in runs:
            await db.delete(r)
        await db.commit()
        return AdminResult(ok=True, message=f"Deleted {len(runs)} run(s)", affected=len(runs))
    else:
        # Clear all terminal runs
        allowed = [s.value for s in TERMINAL_STATUSES]
        result = await db.execute(
            delete(ETLRun).where(ETLRun.status.in_(allowed))
        )
        await db.commit()
        count = result.rowcount
        return AdminResult(ok=True, message=f"Cleared {count} completed/failed run(s)", affected=count)


# ─── Stats reset ──────────────────────────────────────────────────────────────

@router.post("/stats/reset", response_model=AdminResult)
async def reset_stats(db: AsyncSession = Depends(get_db)):
    """Zero out pipeline-level statistics (does not delete run history)."""
    from app.models.etl import ETLPipeline
    result = await db.execute(select(ETLPipeline))
    pipelines = result.scalars().all()
    for p in pipelines:
        p.last_run_status = None
        p.last_run_at = None
    await db.commit()
    return AdminResult(ok=True, message=f"Stats reset for {len(pipelines)} pipeline(s)", affected=len(pipelines))


@router.post("/errors/clear", response_model=AdminResult)
async def clear_errors(db: AsyncSession = Depends(get_db)):
    """Delete all service error log entries."""
    result = await db.execute(delete(ServiceError))
    await db.commit()
    return AdminResult(ok=True, message=f"Cleared {result.rowcount} error(s)", affected=result.rowcount)


# ─── Service restart ──────────────────────────────────────────────────────────

VALID_SERVICES = {
    "spark:master", "spark:worker", "spark:thrift",
    "spark:connect", "spark:history",
    "grpc", "all",
}


@router.post("/services/restart", response_model=ServiceRestartResult)
async def restart_service(service: str = Body(..., embed=True)):
    """
    Restart a named service via platform.sh.
    Valid: spark:master, spark:worker, spark:thrift, spark:connect, spark:history, grpc, all.
    """
    if service not in VALID_SERVICES:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown service '{service}'. Valid: {sorted(VALID_SERVICES)}",
        )
    project_root = Path(settings.SPARK_HOME).parents[0]
    script = project_root / "scripts" / "platform.sh"
    if not script.exists():
        raise HTTPException(status_code=500, detail="platform.sh not found")

    try:
        proc = await asyncio.create_subprocess_exec(
            str(script), "restart", service,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            cwd=str(project_root),
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=120)
        output = stdout.decode(errors="replace")
        ok = proc.returncode == 0
        return ServiceRestartResult(
            service=service,
            ok=ok,
            message=output[-500:] if output else ("OK" if ok else "Failed"),
        )
    except asyncio.TimeoutError:
        return ServiceRestartResult(service=service, ok=False, message="Restart timed out after 120s")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
