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


def _safe_job_token(value: str) -> str:
    token = re.sub(r"[^A-Za-z0-9]+", "_", (value or "").strip()).strip("_")
    return token.upper() if token else "SRC"


def _safe_path_token(value: str, fallback: str) -> str:
    token = re.sub(r"[^A-Za-z0-9]+", "_", (value or "").strip()).strip("_")
    return token.upper() if token else fallback


def _build_canvas_source_branches(canvas: dict, base_job_name: str) -> list[dict]:
    """Build per-source execution plans from the current canvas graph.

    Each branch contains:
      - extract_overrides: source-specific ExtractConfig patch
      - load_overrides: nearest downstream load node patch
      - transform_node_ids: transform nodes reachable from this source
      - job_name: source-scoped output root to avoid collisions
    """
    nodes = canvas.get("nodes") or []
    edges = canvas.get("edges") or []
    if not nodes or not edges:
        return []

    node_by_id = {str(n.get("id")): n for n in nodes if n.get("id") is not None}
    out_edges: dict[str, list[str]] = {}
    in_edges: dict[str, list[str]] = {}
    in_deg: dict[str, int] = {}
    for nid in node_by_id:
        out_edges[nid] = []
        in_edges[nid] = []
        in_deg[nid] = 0
    for e in edges:
        src = str(e.get("source") or "")
        tgt = str(e.get("target") or "")
        if src in out_edges and tgt in in_deg:
            out_edges[src].append(tgt)
            in_edges[tgt].append(src)
            in_deg[tgt] += 1

    # Topological order used to keep transform order deterministic per branch.
    queue = [nid for nid, deg in in_deg.items() if deg == 0]
    topo: list[str] = []
    while queue:
        cur = queue.pop(0)
        topo.append(cur)
        for nxt in out_edges.get(cur, []):
            in_deg[nxt] -= 1
            if in_deg[nxt] == 0:
                queue.append(nxt)

    source_types = {"jdbc_extract", "dw_extract", "s3_extract"}
    transform_types = {"filter", "join", "sort", "lookup", "sql_transform", "aggregate", "notebook_transform"}
    load_types = {"load_sql", "load_parquet"}

    source_nodes = [
        n for n in nodes
        if str((n.get("data") or {}).get("nodeType") or "") in source_types
    ]
    if not source_nodes:
        return []

    branches: list[dict] = []

    # Pre-compute reachable sets for all source nodes so we can identify exclusive nodes
    reachable_by_source: dict[str, set[str]] = {}
    for s in source_nodes:
        sid = str(s.get("id"))
        stack = [sid]
        visited: set[str] = set()
        reachable: set[str] = set()
        while stack:
            cur = stack.pop()
            if cur in visited:
                continue
            visited.add(cur)
            for nxt in out_edges.get(cur, []):
                if nxt not in visited:
                    stack.append(nxt)
                reachable.add(nxt)
        reachable_by_source[sid] = reachable

    for s in source_nodes:
        sid = str(s.get("id"))
        data = s.get("data") or {}
        node_type = str(data.get("nodeType") or "")
        cfg = data.get("config") or {}

        reachable = reachable_by_source[sid]

        # Exclusive nodes: reachable from this source but NOT from any other source
        other_reachable = set()
        for osid, oreachable in reachable_by_source.items():
            if osid != sid:
                other_reachable |= oreachable
        exclusive_reachable = reachable - other_reachable

        transform_node_ids = [
            nid for nid in topo
            if nid in reachable and str((node_by_id.get(nid, {}).get("data") or {}).get("nodeType") or "") in transform_types
        ]

        execution_node_ids = [
            nid for nid in topo
            if nid in reachable and str((node_by_id.get(nid, {}).get("data") or {}).get("nodeType") or "") in (transform_types | load_types)
        ]
        execution_nodes = []
        for nid in execution_node_ids:
            _n = node_by_id.get(nid, {})
            _d = _n.get("data") or {}
            execution_nodes.append({
                "node_id": nid,
                "node_type": str(_d.get("nodeType") or ""),
                "label": str(_d.get("label") or "").strip() or nid,
                "config": _d.get("config") or {},
            })

        # Final load: last reachable load node (shared or exclusive) — actual execution target
        load_node = None
        load_node_id: Optional[str] = None
        load_node_label: Optional[str] = None
        for nid in topo:
            if nid not in reachable:
                continue
            ntype = str((node_by_id.get(nid, {}).get("data") or {}).get("nodeType") or "")
            if ntype in load_types:
                load_node = node_by_id[nid]
                load_node_id = nid
                load_node_label = str(((load_node or {}).get("data") or {}).get("label") or nid).strip() or nid
                # keep scanning so the last reachable load node becomes the branch sink

        # Intermediate load: first exclusive load node for this source (staging node, tracked separately)
        intermediate_load_node_id: Optional[str] = None
        intermediate_load_node_label: Optional[str] = None
        for nid in topo:
            if nid not in exclusive_reachable:
                continue
            ntype = str((node_by_id.get(nid, {}).get("data") or {}).get("nodeType") or "")
            if ntype in load_types:
                _iln = node_by_id[nid]
                intermediate_load_node_id = nid
                intermediate_load_node_label = str((_iln.get("data") or {}).get("label") or nid).strip() or nid
                break  # first exclusive load only

        # In single-source graphs the exclusive load can be the same node as the
        # final sink load; do not create a duplicate intermediate load in that case.
        if intermediate_load_node_id and intermediate_load_node_id == load_node_id:
            intermediate_load_node_id = None
            intermediate_load_node_label = None

        extract_overrides: dict = {}
        load_overrides: dict = {}

        if node_type == "jdbc_extract":
            extract_overrides.update({
                "source_type": "jdbc",
                "jdbc_connection_id": int(cfg.get("connection_id")) if cfg.get("connection_id") is not None else None,
                "jdbc_sql": cfg.get("sql") or None,
                "jdbc_sql_file_id": int(cfg.get("sql_file_id")) if cfg.get("sql_file_id") else None,
                "jdbc_date_var_format": cfg.get("date_format") or "YYYY-MM-DD",
            })
            chunk_size = cfg.get("chunk_size")
            if chunk_size:
                extract_overrides["rows_per_segment"] = int(chunk_size)
        elif node_type == "dw_extract":
            extract_overrides.update({
                "source_type": "datawarehouse",
                "dw_connection_id": int(cfg.get("connection_id")) if cfg.get("connection_id") is not None else None,
                "jdbc_sql_file_id": int(cfg.get("sql_file_id")) if cfg.get("sql_file_id") else None,
                "jdbc_date_var_format": cfg.get("date_format") or "YYYY-MM-DD",
                "jdbc_date_range_mode": cfg.get("date_range_mode") or "current_month",
                "jdbc_date_range_from": cfg.get("date_from") or None,
                "jdbc_date_range_to": cfg.get("date_to") or None,
            })
        elif node_type == "s3_extract":
            extract_overrides.update({
                "source_type": "s3",
                "s3_connection_id": int(cfg.get("connection_id")) if cfg.get("connection_id") is not None else None,
                "s3_prefix": cfg.get("prefix") or "",
                "s3_pattern": cfg.get("pattern") or "*",
                "s3_format": cfg.get("format") or "auto",
                "s3_write_mode": cfg.get("write_mode") or "overwrite",
                "s3_target_db": cfg.get("target_db") or "default",
                "s3_target_table": cfg.get("target_table") or None,
                "s3_transform_sql": cfg.get("transform_sql") or None,
                "s3_csv_sep": cfg.get("csv_sep") or ",",
            })

        if load_node:
            ldata = load_node.get("data") or {}
            ltype = str(ldata.get("nodeType") or "")
            lcfg = ldata.get("config") or {}
            if ltype == "load_sql":
                ns = (lcfg.get("namespace_db") or lcfg.get("database") or "").strip()
                load_overrides.update({
                    "target": "spark_table",
                    "table_name": (lcfg.get("table_name") or "").strip() or None,
                    "mode": lcfg.get("mode") or "overwrite",
                    **({"namespace_db": ns} if ns else {}),
                })
            elif ltype == "load_parquet":
                load_overrides.update({
                    "target": "parquet",
                    "mode": lcfg.get("mode") or "overwrite",
                })
                if lcfg.get("output_dir"):
                    extract_overrides["parquet_output_dir"] = str(lcfg.get("output_dir")).strip()
                elif lcfg.get("path_template"):
                    extract_overrides["parquet_path_template"] = str(lcfg.get("path_template")).strip()
                if lcfg.get("mode"):
                    extract_overrides["parquet_write_mode"] = str(lcfg.get("mode"))

        raw_label = str(data.get("label") or "").strip()
        extract_label = _safe_path_token(raw_label or sid, _safe_job_token(sid))

        # Find upstream iterator node (walk backwards from source node)
        iterator_node_id: Optional[str] = None
        _walk = list(in_edges.get(sid, []))
        _visited_up: set[str] = set()
        while _walk:
            _uid = _walk.pop()
            if _uid in _visited_up:
                continue
            _visited_up.add(_uid)
            _un = node_by_id.get(_uid, {})
            _utype = str((_un.get("data") or {}).get("nodeType") or "")
            if _utype == "iterator":
                iterator_node_id = _uid
                break
            _walk.extend(in_edges.get(_uid, []))

        # Branches without an upstream iterator must NOT inherit the global app
        # list that _apply_canvas_to_extract_cfg places on extract_cfg from the
        # iterator node.  Explicitly clear it so no APP_xxx sub-folder is added.
        if iterator_node_id is None:
            extract_overrides["apps"] = []

        branches.append({
            "source_node_id": sid,
            "source_node_type": node_type,
            "iterator_node_id": iterator_node_id,
            "intermediate_load_node_id": intermediate_load_node_id,
            "intermediate_load_node_label": intermediate_load_node_label,
            "load_node_id": load_node_id,
            "load_node_label": load_node_label,
            "label": raw_label or sid,
            "extract_label": extract_label,
            "pipeline_name": _safe_path_token(base_job_name, "PIPELINE"),
            "job_name": f"{base_job_name}_{_safe_job_token(sid)}",
            "extract_overrides": {k: v for k, v in extract_overrides.items() if v is not None},
            "load_overrides": {k: v for k, v in load_overrides.items() if v is not None},
            "transform_node_ids": transform_node_ids,
            "execution_nodes": execution_nodes,
        })

    return branches


def _has_path_between(canvas: dict, from_types: set[str], to_types: set[str]) -> bool:
    """Return True when at least one node in from_types can reach a node in to_types."""
    nodes = canvas.get("nodes") or []
    edges = canvas.get("edges") or []
    if not nodes or not edges:
        return False

    node_by_id = {str(n.get("id")): n for n in nodes if n.get("id") is not None}
    out_edges: dict[str, list[str]] = {nid: [] for nid in node_by_id}
    for e in edges:
        src = str(e.get("source") or "")
        tgt = str(e.get("target") or "")
        if src in out_edges and tgt in node_by_id:
            out_edges[src].append(tgt)

    from_ids = [
        nid for nid, n in node_by_id.items()
        if str((n.get("data") or {}).get("nodeType") or "") in from_types
    ]
    if not from_ids:
        return False

    for sid in from_ids:
        stack = [sid]
        seen: set[str] = set()
        while stack:
            cur = stack.pop()
            if cur in seen:
                continue
            seen.add(cur)
            ctype = str((node_by_id.get(cur, {}).get("data") or {}).get("nodeType") or "")
            if cur != sid and ctype in to_types:
                return True
            stack.extend(out_edges.get(cur, []))
    return False


def _validate_supported_canvas_shape(canvas: dict) -> list[str]:
    """Validate canvas topology against current engine capabilities.

    Current engine supports one terminal load sink per source branch.
    Load nodes are terminal sinks and must not have outgoing edges.
    """
    nodes = canvas.get("nodes") or []
    edges = canvas.get("edges") or []
    if not nodes:
        return []

    node_by_id = {str(n.get("id")): n for n in nodes if n.get("id") is not None}
    out_edges: dict[str, list[str]] = {nid: [] for nid in node_by_id}
    for e in edges:
        src = str(e.get("source") or "")
        tgt = str(e.get("target") or "")
        if src in out_edges and tgt in node_by_id:
            out_edges[src].append(tgt)

    def _type(nid: str) -> str:
        return str((node_by_id.get(nid, {}).get("data") or {}).get("nodeType") or "")

    source_types = {"jdbc_extract", "dw_extract", "s3_extract", "csv_extract", "json_extract"}
    load_types = {"load_sql", "load_parquet"}
    issues: list[str] = []

    # 1) Load nodes must be terminal in current execution model.
    for nid in node_by_id:
        if _type(nid) in load_types and out_edges.get(nid):
            issues.append(
                f"Load node {nid} has downstream edges. Load nodes must be terminal sinks."
            )

    # 2) Each source branch may target only one reachable load node.
    for sid in [nid for nid in node_by_id if _type(nid) in source_types]:
        stack = [sid]
        seen: set[str] = set()
        reached_loads: set[str] = set()
        while stack:
            cur = stack.pop()
            if cur in seen:
                continue
            seen.add(cur)
            if cur != sid and _type(cur) in load_types:
                reached_loads.add(cur)
            stack.extend(out_edges.get(cur, []))
        if len(reached_loads) > 1:
            issues.append(
                f"Source node {sid} reaches multiple load nodes ({', '.join(sorted(reached_loads))}). "
                "Current execution supports one terminal load per source path."
            )

    return issues


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
            selected_keys = [str(k) for k in (cfg.get("selected_keys") or [])]
            entry_filters_raw = cfg.get("entry_filters") or []
            entry_filters: list[tuple[str, str]] = []
            for item in entry_filters_raw:
                if not isinstance(item, dict):
                    continue
                column = str(item.get("column") or "").strip()
                value = str(item.get("value") or "").strip()
                if not column or not value:
                    continue
                entry_filters.append((column, value))

            def _matches_entry_filters(entry: "DictionaryEntry") -> bool:
                if not entry_filters:
                    return True
                extra = entry.extra or {}
                for column, value in entry_filters:
                    if str(extra.get(column, "")) != value:
                        return False
                return True

            if dict_id:
                from app.models.etl import DictionaryEntry
                if selected_keys:
                    rows = await db.execute(
                        _sel(DictionaryEntry)
                        .where(DictionaryEntry.dictionary_id == int(dict_id))
                        .where(DictionaryEntry.key.in_(selected_keys))
                    )
                    entries = rows.scalars().all()
                    entries = [e for e in entries if _matches_entry_filters(e)]
                    # Preserve selected key order for deterministic app iteration.
                    entry_map = {str(e.key): e for e in entries}
                    apps = [
                        {"id": str(entry_map[k].key), "name": str(entry_map[k].value)}
                        for k in selected_keys
                        if k in entry_map
                    ]
                else:
                    # Empty selected_keys means "all entries" in the iterator UI.
                    rows = await db.execute(
                        _sel(DictionaryEntry)
                        .where(DictionaryEntry.dictionary_id == int(dict_id))
                        .order_by(DictionaryEntry.id)
                    )
                    entries = rows.scalars().all()
                    entries = [e for e in entries if _matches_entry_filters(e)]
                    apps = [{"id": str(e.key), "name": str(e.value)} for e in entries]
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
            limit = cfg.get("limit")
            if limit is not None:
                try:
                    updates["jdbc_row_limit"] = int(limit)
                except (TypeError, ValueError):
                    pass

        elif node_type == "load_parquet":
            if cfg.get("output_dir"):
                updates["parquet_output_dir"] = str(cfg["output_dir"]).strip()
            elif cfg.get("path_template"):
                updates["parquet_path_template"] = str(cfg["path_template"]).strip()
            if cfg.get("mode"):
                updates["parquet_write_mode"] = str(cfg["mode"])

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
        status=body.status or "active",
        tags=body.tags,
        extract_config=body.extract_config.model_dump(),
        transform_config=body.transform_config.model_dump(),
        load_config=body.load_config.model_dump(),
        canvas_config=body.canvas_config,
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
    if not extract_cfg.pipeline_name:
        extract_cfg = extract_cfg.model_copy(update={"pipeline_name": extract_cfg.job_name})

    # Multi-source branch planning: keep legacy single-source fields for backwards
    # compatibility, and attach explicit branch plans for the execution engine.
    canvas = pipeline.canvas_config or {}
    canvas_nodes = canvas.get("nodes") or []
    if canvas_nodes:
        source_types = {"jdbc_extract", "dw_extract", "s3_extract", "csv_extract", "json_extract"}
        node_types = [str((n.get("data") or {}).get("nodeType") or "") for n in canvas_nodes]
        has_source_node = any(
            str((n.get("data") or {}).get("nodeType") or "") in source_types
            for n in canvas_nodes
        )
        if not has_source_node:
            has_sql_transform = "sql_transform" in node_types
            has_load_sql = "load_sql" in node_types

            # SQL-only Spark mode: sql_transform reads from Spark source DB and
            # load_sql writes to target table, with no extract node.
            sql_only_allowed = False
            if has_sql_transform and has_load_sql:
                sql_nodes = [
                    n for n in canvas_nodes
                    if str((n.get("data") or {}).get("nodeType") or "") == "sql_transform"
                ]
                if sql_nodes and all(
                    (n.get("data") or {}).get("config", {}).get("sql_file_id")
                    for n in sql_nodes
                ):
                    sql_only_allowed = True

            if sql_only_allowed:
                extract_cfg = extract_cfg.model_copy(update={"source_type": "spark_sql"})
            else:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        (
                            "Pipeline canvas has no source node. For Spark SQL source mode, set both "
                            "sql_file_id on every SQL Transform node, and keep a Load SQL target node. "
                            "source_database defaults dynamically to data_<business_date> if left empty."
                        )
                        if has_sql_transform else
                        (
                            "Pipeline canvas has no source extract node. Add a source node "
                            "(JDBC, DataWarehouse, S3, CSV or JSON) upstream of transforms/load."
                        )
                    ),
                )
    branch_plans = _build_canvas_source_branches(canvas, extract_cfg.job_name or _pipeline_to_job_name(pipeline.name))

    # Enforce source->load connectivity in the canvas. A disconnected source node
    # should not silently pass checklist/run and then execute unpredictably.
    if branch_plans:
        orphan_branches = [
            p for p in branch_plans
            if not str(p.get("load_node_id") or "").strip()
        ]
        if orphan_branches:
            details = ", ".join(
                f"{str(p.get('label') or p.get('source_node_id') or 'source')}"
                f"[{str(p.get('source_node_id') or '?')}]"
                for p in orphan_branches
            )
            raise HTTPException(
                status_code=400,
                detail=(
                    "Disconnected source node(s) detected with no downstream load node: "
                    f"{details}. Connect each source to a load path before running."
                ),
            )

    # SQL-only mode must contain a real connected path: sql_transform -> load_sql.
    if extract_cfg.source_type == "spark_sql":
        if not _has_path_between(canvas, {"sql_transform"}, {"load_sql"}):
            raise HTTPException(
                status_code=400,
                detail=(
                    "Spark SQL source mode requires a connected path from SQL Transform "
                    "to Load SQL. Add an edge between them before running."
                ),
            )

    resume_from_job_name: Optional[str] = None
    skip_failed_step: bool = False
    if body.resume_from_failed:
        failed_res = await db.execute(
            select(ETLRun)
            .where(ETLRun.pipeline_id == pid)
            .where(ETLRun.status == RunStatus.FAILED)
            .order_by(desc(ETLRun.created_at))
            .limit(1)
        )
        failed_run = failed_res.scalar_one_or_none()
        if not failed_run:
            raise HTTPException(status_code=400, detail="No failed run found to resume from.")
        resume_from_job_name = str((failed_run.run_metadata or {}).get("failed_branch_job_name") or "").strip() or None
        if branch_plans and not resume_from_job_name:
            raise HTTPException(
                status_code=400,
                detail="Latest failed run is not resumable (missing failed branch marker). Run full pipeline once.",
            )
    elif body.skip_failed_step:
        failed_res = await db.execute(
            select(ETLRun)
            .where(ETLRun.pipeline_id == pid)
            .where(ETLRun.status == RunStatus.FAILED)
            .order_by(desc(ETLRun.created_at))
            .limit(1)
        )
        failed_run = failed_res.scalar_one_or_none()
        if not failed_run:
            raise HTTPException(status_code=400, detail="No failed run found to skip failed step from.")
        skip_failed_step = True

    update_payload: dict = {}
    if branch_plans:
        update_payload["source_branches"] = branch_plans
        if resume_from_job_name:
            branch_names = {str(p.get("job_name") or "").strip() for p in branch_plans}
            if resume_from_job_name not in branch_names:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "Failed branch no longer exists in current canvas config. "
                        "Run full pipeline to rebuild outputs."
                    ),
                )
            update_payload["resume_from_job_name"] = resume_from_job_name
    if skip_failed_step:
        update_payload["skip_failed_step"] = True
    if update_payload:
        extract_cfg = extract_cfg.model_copy(update=update_payload)

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
            await execute_pipeline(
                bg_db,
                bg_run,
                extract_cfg,
                transform_cfg,
                load_cfg,
                business_date=_resolved_date,
                run_scope=body.run_scope,
            )

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
        display_name=body.display_name,
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
