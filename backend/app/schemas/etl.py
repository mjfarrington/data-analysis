from __future__ import annotations
from datetime import datetime
from typing import Optional, Any
from pydantic import BaseModel, Field, ConfigDict


# ─────────────────────────────────────────────────────────────────────────────
# Pipeline schemas
# ─────────────────────────────────────────────────────────────────────────────
class ExtractConfig(BaseModel):
    # Source selector
    source_type: str = "grpc"  # grpc | jdbc | json | csv

    # gRPC source
    application_ids: list[str] = Field(default_factory=list)

    # Date range (all sources)
    dates: list[str] = Field(default_factory=list)   # explicit list of YYYY-MM-DD
    date_from: Optional[str] = None                  # range start
    date_to: Optional[str] = None                    # range end

    # Segmentation — rows per output file
    rows_per_segment: int = Field(default=100_000, ge=1_000, le=10_000_000)
    page_size: int = Field(default=10_000, ge=100, le=1_000_000)  # gRPC fetch batch

    output_format: str = "parquet"  # parquet | csv

    # JDBC source
    jdbc_url: Optional[str] = None            # SQLAlchemy connection string
    jdbc_sql_file_id: Optional[int] = None    # reference to SqlFile.id
    jdbc_sql: Optional[str] = None            # inline SQL (alternative to file)
    jdbc_table: Optional[str] = None          # simple table name (no SQL needed)
    jdbc_date_column: Optional[str] = None    # column used for date filtering

    # File source (json / csv)
    file_path: Optional[str] = None           # relative to DATA_DIR/sources/
    file_encoding: str = "utf-8"
    csv_delimiter: str = ","
    csv_has_header: bool = True
    json_lines: bool = True                   # True = JSONL, False = JSON array


class TransformConfig(BaseModel):
    filters: dict[str, Any] = Field(default_factory=dict)
    drop_columns: list[str] = Field(default_factory=list)
    rename_columns: dict[str, str] = Field(default_factory=dict)
    dedup: bool = True
    dedup_keys: list[str] = Field(default_factory=lambda: ["id"])


class LoadConfig(BaseModel):
    target: str = "parquet"  # parquet | csv | spark_table
    table_name: Optional[str] = None
    # When True, ignore table_name and use the platform namespace
    # (namespace_prefix + business_date) as the Spark table name.
    use_namespace: bool = False
    # Resolved at run time: the Spark database that acts as the namespace.
    # e.g. "markets_20260414". Tables are created INSIDE this database.
    namespace_db: Optional[str] = None
    partition_by: list[str] = Field(default_factory=lambda: ["date", "application_id"])
    mode: str = "overwrite"  # overwrite | append


class PipelineBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    description: Optional[str] = None
    extract_config: ExtractConfig = Field(default_factory=ExtractConfig)
    transform_config: TransformConfig = Field(default_factory=TransformConfig)
    load_config: LoadConfig = Field(default_factory=LoadConfig)
    schedule: Optional[str] = None
    schedule_enabled: bool = False


class PipelineCreate(PipelineBase):
    pass


class PipelineUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    description: Optional[str] = None
    status: Optional[str] = None
    extract_config: Optional[ExtractConfig] = None
    transform_config: Optional[TransformConfig] = None
    load_config: Optional[LoadConfig] = None
    schedule: Optional[str] = None
    schedule_enabled: Optional[bool] = None


class PipelineResponse(PipelineBase):
    model_config = ConfigDict(from_attributes=True)
    id: int
    status: str
    created_at: datetime
    updated_at: datetime
    last_run: Optional["RunSummary"] = None
    total_runs: int = 0


# ─────────────────────────────────────────────────────────────────────────────
# Run schemas
# ─────────────────────────────────────────────────────────────────────────────
class RunTrigger(BaseModel):
    extract_config: Optional[ExtractConfig] = None  # override pipeline config
    # Inline overrides — take precedence over the pipeline's load_config
    business_date: Optional[str] = None    # YYYY-MM-DD override for this run
    namespace_prefix: Optional[str] = None # prefix override for this run
    use_namespace: Optional[bool] = None   # force namespace on/off for this run


class RunSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    pipeline_id: int
    status: str
    triggered_by: str
    started_at: Optional[datetime]
    finished_at: Optional[datetime]
    duration_seconds: Optional[float]
    records_extracted: int
    records_loaded: int
    segments_processed: int
    error_message: Optional[str]
    created_at: datetime


class RunDetail(RunSummary):
    records_transformed: int
    run_metadata: Optional[dict]
    logs: list["RunLogEntry"] = Field(default_factory=list)
    extract_jobs: list["ExtractJobSummary"] = Field(default_factory=list)


class RunLogEntry(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    level: str
    message: str
    step: Optional[str]
    timestamp: datetime
    extra: Optional[dict]


class ExtractJobSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    application_id: str
    date: str
    segment: int
    total_segments: Optional[int]
    status: str
    records_count: int
    output_path: Optional[str]
    output_format: str
    started_at: Optional[datetime]
    finished_at: Optional[datetime]
    error_message: Optional[str]


# ─────────────────────────────────────────────────────────────────────────────
# Service status schemas
# ─────────────────────────────────────────────────────────────────────────────
class ServiceInfo(BaseModel):
    name: str
    status: str  # healthy | degraded | unhealthy | unknown
    url: Optional[str] = None
    message: Optional[str] = None
    latency_ms: Optional[float] = None
    details: Optional[dict] = None


class ServicesStatus(BaseModel):
    overall: str
    services: list[ServiceInfo]
    checked_at: datetime


class GrpcServiceStatus(BaseModel):
    connected: bool
    server_version: Optional[str]
    server_id: Optional[str]
    uptime_seconds: Optional[int]
    active_connections: int
    total_records_served: int
    avg_response_time_ms: float
    records_per_second: float


# ─────────────────────────────────────────────────────────────────────────────
# Data / Spark schemas
# ─────────────────────────────────────────────────────────────────────────────
class DataTable(BaseModel):
    name: str
    path: str
    format: str
    size_bytes: int
    row_count: Optional[int]
    columns: list[str]
    partitions: list[str]
    last_modified: Optional[datetime]


class QueryRequest(BaseModel):
    sql: str = Field(..., min_length=1, max_length=10_000)
    limit: int = Field(default=1000, ge=1, le=10_000)
    database: Optional[str] = None  # If set, USE this database before executing


class QueryResult(BaseModel):
    columns: list[str]
    rows: list[list[Any]]
    row_count: int
    truncated: bool
    duration_ms: float


class SparkTestItem(BaseModel):
    name: str
    status: str          # passed | failed | skipped
    duration_ms: float
    detail: Optional[str] = None


class SparkTestResult(BaseModel):
    overall: str         # passed | failed
    tests: list[SparkTestItem]
    total_ms: float
    spark_version: Optional[str] = None
    catalog_tables: Optional[int] = None


# ─────────────────────────────────────────────────────────────────────────────
# Execution context schemas
# ─────────────────────────────────────────────────────────────────────────────
class ExecutionContextResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    business_date: Optional[str]
    namespace_prefix: str
    # Derived: the full namespace string
    namespace: Optional[str]  # e.g. "markets_20260414" or None if no date set
    updated_at: datetime


class ExecutionContextUpdate(BaseModel):
    business_date: Optional[str] = None   # YYYY-MM-DD or null to clear
    namespace_prefix: Optional[str] = None


class ErrorRecord(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    service: str
    level: str
    message: str
    traceback: Optional[str]
    context: Optional[dict]
    resolved: bool
    timestamp: datetime


PipelineResponse.model_rebuild()
RunDetail.model_rebuild()


# ─────────────────────────────────────────────────────────────────────────────
# SQL File schemas
# ─────────────────────────────────────────────────────────────────────────────
class SqlFileCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    description: Optional[str] = None
    content: str = Field(..., min_length=1)


class SqlFileUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    description: Optional[str] = None
    content: Optional[str] = None


class SqlFileResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    description: Optional[str]
    content: str
    created_at: datetime
    updated_at: datetime


# ─────────────────────────────────────────────────────────────────────────────
# Pipeline dependency schemas
# ─────────────────────────────────────────────────────────────────────────────
class DependencyCreate(BaseModel):
    upstream_id: int = Field(..., description="Pipeline that must complete first")


class DependencyResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    pipeline_id: int
    upstream_id: int
    created_at: datetime


class GraphNode(BaseModel):
    """Lightweight pipeline summary for the graph view."""
    id: int
    name: str
    description: Optional[str]
    status: str
    source_type: str
    last_run_status: Optional[str] = None


class GraphEdge(BaseModel):
    id: str          # "dep-{id}"
    source: int      # upstream_id
    target: int      # pipeline_id (downstream)
    dependency_id: int


class PipelineGraph(BaseModel):
    nodes: list[GraphNode]
    edges: list[GraphEdge]
