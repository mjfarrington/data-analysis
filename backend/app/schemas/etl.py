from __future__ import annotations
from datetime import datetime
from typing import Optional, Any
from pydantic import BaseModel, Field, ConfigDict


# ─────────────────────────────────────────────────────────────────────────────
# Pipeline schemas
# ─────────────────────────────────────────────────────────────────────────────
class ExtractConfig(BaseModel):
    # Source selector
    source_type: str = "datawarehouse"  # jdbc | datawarehouse | json | csv

    # Unified application list — used by ALL source types.
    # Each entry: {"name": "<display name>", "id": "<app_id>"}
    # app_id  → folder name on disk, passed to gRPC, substituted as $app_id in SQL
    # app_name (name field) → substituted as $app_name in SQL
    apps: list[dict] = Field(default_factory=list)

    # Persisted dictionary picker state for the apps chip field
    dw_dict_id: Optional[int] = None        # which dictionary to pick apps from
    dw_dict_name_field: Optional[str] = None  # 'key' | 'value'  — which column = $app_name

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
    jdbc_connection_id: Optional[int] = None  # named Connection (conn_type=jdbc)
    jdbc_sql_file_id: Optional[int] = None    # reference to SqlFile.id
    jdbc_sql: Optional[str] = None            # inline SQL (alternative to file)
    jdbc_table: Optional[str] = None          # simple table name (no SQL needed)
    jdbc_date_column: Optional[str] = None    # column used for date filtering

    # SQL variable injection (JDBC + DataWarehouse)
    # Placeholders resolved at run time: $business_date, $business_date_from,
    # $business_date_to, $business_date_range
    jdbc_date_var_format: str = "YYYYMMDD"   # YYYYMMDD | YYYY-MM-DD | YYYYMM | YYYY/MM/DD | DD/MM/YYYY | MM/DD/YYYY
    jdbc_date_range_mode: str = "single"     # single | current_month | previous_month | custom
    jdbc_date_range_from: Optional[str] = None   # YYYY-MM-DD (custom range start)
    jdbc_date_range_to: Optional[str] = None     # YYYY-MM-DD (custom range end)

    # DataWarehouse source
    dw_connection_id: Optional[int] = None   # named Connection (conn_type=datawarehouse)

    # File source (json / csv)
    file_path: Optional[str] = None           # relative to DATA_DIR/sources/
    file_encoding: str = "utf-8"
    csv_delimiter: str = ","
    csv_has_header: bool = True
    json_lines: bool = True                   # True = JSONL, False = JSON array

    # Output directory label — auto-derived from pipeline name if not set.
    # Rendered as uppercase-with-underscores, e.g. "My Job" → "MY_JOB".
    # Output path: <DATE>/<job_name>/<app_id>/
    job_name: Optional[str] = None


class TransformStep(BaseModel):
    """One step in a canvas-derived transform pipeline."""
    node_id: str = ""
    node_type: str  # filter | sort | aggregate | lookup | join | sql_transform
    config: dict[str, Any] = Field(default_factory=dict)


class TransformConfig(BaseModel):
    # Legacy simple transforms (still applied first for backward compatibility)
    filters: dict[str, Any] = Field(default_factory=dict)
    drop_columns: list[str] = Field(default_factory=list)
    rename_columns: dict[str, str] = Field(default_factory=dict)
    dedup: bool = False
    dedup_keys: list[str] = Field(default_factory=list)
    # Canvas-derived ordered transform pipeline (applied after legacy transforms)
    transforms_pipeline: list[TransformStep] = Field(default_factory=list)


class LoadConfig(BaseModel):
    target: str = "parquet"  # parquet | csv | spark_table
    table_name: Optional[str] = None
    # Resolved at run time from business_date — do not set manually.
    namespace_db: Optional[str] = None
    partition_by: list[str] = Field(default_factory=lambda: ["date", "application_id"])
    mode: str = "overwrite"  # overwrite | append


class LoadSparkRequest(BaseModel):
    """Request body for the manual load-to-Spark endpoint."""
    date: str                            # YYYY-MM-DD business date to load
    namespace_db: str                    # Spark database to write into
    table_name: Optional[str] = None     # Override table name (default: <job_name>)
    mode: str = "overwrite"              # overwrite | append


class PipelineBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    description: Optional[str] = None
    tags: list[str] = Field(default_factory=list)
    extract_config: ExtractConfig = Field(default_factory=ExtractConfig)
    transform_config: TransformConfig = Field(default_factory=TransformConfig)
    load_config: LoadConfig = Field(default_factory=LoadConfig)
    canvas_config: Optional[dict] = Field(default_factory=dict)
    schedule: Optional[str] = None
    schedule_enabled: bool = False


class PipelineCreate(PipelineBase):
    pass


class PipelineUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    description: Optional[str] = None
    tags: Optional[list[str]] = None
    status: Optional[str] = None
    extract_config: Optional[ExtractConfig] = None
    transform_config: Optional[TransformConfig] = None
    load_config: Optional[LoadConfig] = None
    canvas_config: Optional[dict] = None
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
    extract_config: Optional[ExtractConfig] = None  # override pipeline extract config
    business_date: Optional[str] = None             # YYYY-MM-DD override for this run


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
    steps: list["RunStepSummary"] = Field(default_factory=list)


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


class RunStepSummary(BaseModel):
    """Per-step execution summary within a single ETL run."""
    model_config = ConfigDict(from_attributes=True)
    id: int
    run_id: int
    step_order: int
    step_type: str           # "extract", "load", or any canvas node_type
    step_label: Optional[str] = None
    parent_step_id: Optional[int] = None
    status: str              # pending | running | completed | failed | cancelled | skipped
    started_at: Optional[datetime]
    finished_at: Optional[datetime]
    duration_seconds: Optional[float]
    records_in: int
    records_out: int
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
    limit: int = Field(default=500, ge=1, le=500)
    offset: int = Field(default=0, ge=0)
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
    # Optional direct Spark database name override (takes precedence over derived namespace)
    db_name: Optional[str]
    # Resolved Spark database name: db_name if set, else prefix+date, else None
    namespace: Optional[str]
    updated_at: datetime


class ExecutionContextUpdate(BaseModel):
    business_date: Optional[str] = None   # YYYY-MM-DD or null to clear
    namespace_prefix: Optional[str] = None
    db_name: Optional[str] = None  # direct Spark database name (overrides prefix+date)


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


# ─────────────────────────────────────────────────────────────────────────────
# Notebook file schemas
# ─────────────────────────────────────────────────────────────────────────────
class NotebookCell(BaseModel):
    id: Optional[str] = None
    type: str = "code"   # "code" | "markdown"
    content: str = ""
    language: Optional[str] = None  # explicit override; None = auto-detect


class NotebookFileBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    description: Optional[str] = None
    cells: list[NotebookCell] = Field(default_factory=list)


class NotebookFileCreate(NotebookFileBase):
    pass


class NotebookFileUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    cells: Optional[list[NotebookCell]] = None


class NotebookFileResponse(NotebookFileBase):
    model_config = ConfigDict(from_attributes=True)
    id: int
    created_at: datetime
    updated_at: datetime


# ─────────────────────────────────────────────────────────────────────────────
# Transform job schemas
# ─────────────────────────────────────────────────────────────────────────────
class TransformJobBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    description: Optional[str] = None
    tags: list[str] = Field(default_factory=list)
    source_database: Optional[str] = None
    source_table: str
    transform_type: str = "sql"    # "sql" | "notebook"
    sql_content: Optional[str] = None
    sql_file_id: Optional[int] = None
    notebook_file_id: Optional[int] = None
    target_database: Optional[str] = None
    target_table: str
    target_mode: str = "overwrite"


class TransformJobCreate(TransformJobBase):
    pass


class TransformJobUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    tags: Optional[list[str]] = None
    source_database: Optional[str] = None
    source_table: Optional[str] = None
    transform_type: Optional[str] = None
    sql_content: Optional[str] = None
    sql_file_id: Optional[int] = None
    notebook_file_id: Optional[int] = None
    target_database: Optional[str] = None
    target_table: Optional[str] = None
    target_mode: Optional[str] = None


class TransformJobResponse(TransformJobBase):
    model_config = ConfigDict(from_attributes=True)
    id: int
    status: str
    last_run_at: Optional[datetime]
    last_run_duration_s: Optional[float]
    last_run_rows: Optional[int]
    last_error: Optional[str]
    created_at: datetime
    updated_at: datetime
    # Resolved names from FK joins
    sql_file_name: Optional[str] = None
    notebook_file_name: Optional[str] = None


PipelineResponse.model_rebuild()
RunDetail.model_rebuild()
RunStepSummary.model_rebuild()


# ─────────────────────────────────────────────────────────────────────────────
# ETL Chain schemas
# ─────────────────────────────────────────────────────────────────────────────

class ChainStep(BaseModel):
    """One step in an ETL chain — either a pipeline run or a transform job."""
    type: str  # "pipeline" | "transform"
    pipeline_id: Optional[int] = None
    transform_job_id: Optional[int] = None
    # Resolved display names (read-only, populated on response)
    label: Optional[str] = None


class ETLChainBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    description: Optional[str] = None
    steps: list[ChainStep] = Field(default_factory=list)


class ETLChainCreate(ETLChainBase):
    pass


class ETLChainUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    steps: Optional[list[ChainStep]] = None


class ETLChainResponse(ETLChainBase):
    model_config = ConfigDict(from_attributes=True)
    id: int
    status: str
    last_run_at: Optional[datetime] = None
    last_run_duration_s: Optional[float] = None
    last_error: Optional[str] = None
    created_at: datetime
    updated_at: datetime


# ─────────────────────────────────────────────────────────────────────────────
# SQL File schemas
# ─────────────────────────────────────────────────────────────────────────────
SQL_FILE_TYPES = ("extract", "transform")
SQL_VERSION_TAGS = ("DRAFT", "REVIEW", "FINAL", "DEPRECATED")


class SqlFileVersionCreate(BaseModel):
    """Snapshot the current content as a new immutable version."""
    tag: str = Field(default="DRAFT", max_length=50)


class SqlFileVersionTagUpdate(BaseModel):
    tag: str = Field(..., max_length=50)


class SqlFileVersionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    sql_file_id: int
    version: str        # e.g. "v0.3.0"
    tag: str            # e.g. "DRAFT" / "FINAL"
    content: str
    created_at: datetime


class SqlFileCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    description: Optional[str] = None
    file_type: str = Field(default="extract")
    content: str = Field(..., min_length=1)


class SqlFileUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    description: Optional[str] = None
    file_type: Optional[str] = None
    content: Optional[str] = None


class SqlFileResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    description: Optional[str]
    file_type: str
    content: str
    created_at: datetime
    updated_at: datetime
    versions: list[SqlFileVersionResponse] = Field(default_factory=list)


# ─────────────────────────────────────────────────────────────────────────────
# SQL preview (variable injection)
# ─────────────────────────────────────────────────────────────────────────────
class SqlPreviewRequest(BaseModel):
    """Resolve $business_date* placeholders for a given SQL source and return the
    fully substituted SQL for review before running a pipeline."""
    sql: Optional[str] = None           # inline SQL text
    sql_file_id: Optional[int] = None   # reference to SqlFile.id (alternative to sql)
    date_var_format: str = "YYYYMMDD"
    date_range_mode: str = "single"     # single | current_month | previous_month | custom
    date_range_from: Optional[str] = None  # YYYY-MM-DD (custom range start)
    date_range_to: Optional[str] = None    # YYYY-MM-DD (custom range end)
    app_id: Optional[str] = None           # $app_id placeholder value
    app_name: Optional[str] = None         # $app_name placeholder value
    app_name: Optional[str] = None         # $app_name placeholder value


class SqlPreviewResponse(BaseModel):
    resolved_sql: str
    variables: dict[str, str]   # placeholder → resolved value
    business_date: Optional[str]  # YYYY-MM-DD from platform context


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
    app_names: list[str] = []
    load_target: str = "parquet"
    load_table_name: Optional[str] = None
    # Per-step status of the most recent run (keyed by step_type)
    last_run_step_statuses: dict[str, str] = Field(default_factory=dict)


class GraphEdge(BaseModel):
    id: str          # "dep-{id}"
    source: int      # upstream_id
    target: int      # pipeline_id (downstream)
    dependency_id: int


class PipelineGraph(BaseModel):
    nodes: list[GraphNode]
    edges: list[GraphEdge]

# ─────────────────────────────────────────────────────────────────────────────
# Connection schemas
# ─────────────────────────────────────────────────────────────────────────────
CONNECTION_TYPES = ("jdbc", "grpc", "rest", "other", "datawarehouse")


class ConnectionCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    description: Optional[str] = None
    conn_type: str = Field(default="jdbc")
    host: Optional[str] = None
    port: Optional[int] = None
    database: Optional[str] = None
    username: Optional[str] = None
    # plaintext — encrypted before storage
    password: Optional[str] = None
    extra: Optional[dict] = None


class ConnectionUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    description: Optional[str] = None
    conn_type: Optional[str] = None
    host: Optional[str] = None
    port: Optional[int] = None
    database: Optional[str] = None
    username: Optional[str] = None
    # Send None to leave unchanged, send "" to clear, send value to update
    password: Optional[str] = None
    extra: Optional[dict] = None


class ConnectionResponse(BaseModel):
    """Connection without the encrypted secret — password is never returned."""
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    description: Optional[str]
    conn_type: str
    host: Optional[str]
    port: Optional[int]
    database: Optional[str]
    username: Optional[str]
    has_password: bool = False
    extra: Optional[dict]
    created_at: datetime
    updated_at: datetime


class ConnectionTestResult(BaseModel):
    success: bool
    message: str
    latency_ms: Optional[float] = None


# ─────────────────────────────────────────────────────────────────────────────
# Dictionary schemas
# ─────────────────────────────────────────────────────────────────────────────

class DictionaryEntryBase(BaseModel):
    key: str
    value: str


class DictionaryEntryCreate(DictionaryEntryBase):
    pass


class DictionaryEntryUpdate(BaseModel):
    key: Optional[str] = None
    value: Optional[str] = None


class DictionaryEntryOut(DictionaryEntryBase):
    model_config = ConfigDict(from_attributes=True)
    id: int
    dictionary_id: int
    created_at: datetime
    updated_at: datetime


class DictionaryBase(BaseModel):
    name: str
    description: Optional[str] = None
    key_label: str = "Key"
    value_label: str = "Value"


class DictionaryCreate(DictionaryBase):
    pass


class DictionaryUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    key_label: Optional[str] = None
    value_label: Optional[str] = None


class DictionaryOut(DictionaryBase):
    model_config = ConfigDict(from_attributes=True)
    id: int
    created_at: datetime
    updated_at: datetime
    entries: list[DictionaryEntryOut] = []


# ─────────────────────────────────────────────────────────────────────────────
# Metadata Catalogue schemas
# ─────────────────────────────────────────────────────────────────────────────

COLUMN_TYPES = [
    "string", "integer", "long", "float", "double",
    "decimal", "date", "datetime", "boolean", "binary",
]


class CatalogueColumnBase(BaseModel):
    name: str
    data_type: str = "string"
    nullable: bool = True
    description: Optional[str] = None
    position: int = 0


class CatalogueColumnCreate(CatalogueColumnBase):
    pass


class CatalogueColumnUpdate(BaseModel):
    name: Optional[str] = None
    data_type: Optional[str] = None
    nullable: Optional[bool] = None
    description: Optional[str] = None
    position: Optional[int] = None


class CatalogueColumnOut(CatalogueColumnBase):
    model_config = ConfigDict(from_attributes=True)
    id: int
    catalogue_id: int
    created_at: datetime


class CatalogueBase(BaseModel):
    name: str
    description: Optional[str] = None


class CatalogueCreate(CatalogueBase):
    pass


class CatalogueUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None


class CatalogueOut(CatalogueBase):
    model_config = ConfigDict(from_attributes=True)
    id: int
    created_at: datetime
    updated_at: datetime
    columns: list[CatalogueColumnOut] = []
