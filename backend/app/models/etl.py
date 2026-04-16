from __future__ import annotations
import enum
from datetime import datetime
from typing import Optional
from sqlalchemy import (
    Column, Integer, String, Text, DateTime, Enum as SAEnum,
    ForeignKey, BigInteger, Float, JSON, Boolean, func,
)
from sqlalchemy.orm import relationship, Mapped, mapped_column
from app.core.database import Base


class PipelineStatus(str, enum.Enum):
    ACTIVE = "active"
    INACTIVE = "inactive"
    DRAFT = "draft"


class SourceType(str, enum.Enum):
    GRPC = "grpc"
    JDBC = "jdbc"
    JSON = "json"
    CSV = "csv"


class SqlFileType(str, enum.Enum):
    EXTRACT = "extract"
    TRANSFORM = "transform"


class SqlFile(Base):
    __tablename__ = "sql_files"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False, unique=True)
    description: Mapped[Optional[str]] = mapped_column(Text)
    # "extract" = used by JDBC client; "transform" = used by Spark transformer
    file_type: Mapped[str] = mapped_column(
        String(20), nullable=False, default=SqlFileType.EXTRACT
    )
    content: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    versions: Mapped[list["SqlFileVersion"]] = relationship(
        "SqlFileVersion", back_populates="sql_file",
        cascade="all, delete-orphan", order_by="SqlFileVersion.id",
    )


class SqlFileVersion(Base):
    """Immutable snapshot of a SqlFile's content at a point in time."""
    __tablename__ = "sql_file_versions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    sql_file_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("sql_files.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # Semver-style string: "v0.1.0", "v0.2.0", …
    version: Mapped[str] = mapped_column(String(20), nullable=False)
    # User-defined label: DRAFT | FINAL | REVIEW | DEPRECATED | or any freeform string
    tag: Mapped[str] = mapped_column(String(50), nullable=False, default="DRAFT")
    content: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    sql_file: Mapped["SqlFile"] = relationship("SqlFile", back_populates="versions")


class RunStatus(str, enum.Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class ETLPipeline(Base):
    __tablename__ = "etl_pipelines"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False, unique=True)
    description: Mapped[Optional[str]] = mapped_column(Text)
    status: Mapped[str] = mapped_column(
        SAEnum(PipelineStatus), default=PipelineStatus.ACTIVE, nullable=False
    )

    # Extract configuration
    extract_config: Mapped[Optional[dict]] = mapped_column(JSON, default=dict)
    # Transform configuration
    transform_config: Mapped[Optional[dict]] = mapped_column(JSON, default=dict)
    # Load configuration  
    load_config: Mapped[Optional[dict]] = mapped_column(JSON, default=dict)

    # Tags (list of strings stored as JSON)
    tags: Mapped[Optional[list]] = mapped_column(JSON, default=list)

    # Schedule (cron expression or None)
    schedule: Mapped[Optional[str]] = mapped_column(String(100))
    schedule_enabled: Mapped[bool] = mapped_column(Boolean, default=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    runs: Mapped[list[ETLRun]] = relationship(
        "ETLRun", back_populates="pipeline", cascade="all, delete-orphan"
    )
    dependencies: Mapped[list[PipelineDependency]] = relationship(
        "PipelineDependency", foreign_keys="PipelineDependency.pipeline_id",
        back_populates="pipeline", cascade="all, delete-orphan"
    )
    dependents: Mapped[list[PipelineDependency]] = relationship(
        "PipelineDependency", foreign_keys="PipelineDependency.upstream_id",
        back_populates="upstream", cascade="all, delete-orphan"
    )


class ETLRun(Base):
    __tablename__ = "etl_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    pipeline_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("etl_pipelines.id", ondelete="CASCADE"), nullable=False
    )
    status: Mapped[str] = mapped_column(
        SAEnum(RunStatus), default=RunStatus.PENDING, nullable=False
    )
    triggered_by: Mapped[str] = mapped_column(String(50), default="manual")

    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    duration_seconds: Mapped[Optional[float]] = mapped_column(Float)

    records_extracted: Mapped[int] = mapped_column(BigInteger, default=0)
    records_transformed: Mapped[int] = mapped_column(BigInteger, default=0)
    records_loaded: Mapped[int] = mapped_column(BigInteger, default=0)
    segments_processed: Mapped[int] = mapped_column(Integer, default=0)

    error_message: Mapped[Optional[str]] = mapped_column(Text)
    error_traceback: Mapped[Optional[str]] = mapped_column(Text)
    run_metadata: Mapped[Optional[dict]] = mapped_column(JSON, default=dict)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    pipeline: Mapped[ETLPipeline] = relationship("ETLPipeline", back_populates="runs")
    logs: Mapped[list[ETLRunLog]] = relationship(
        "ETLRunLog", back_populates="run", cascade="all, delete-orphan"
    )
    extract_jobs: Mapped[list[ExtractJob]] = relationship(
        "ExtractJob", back_populates="run", cascade="all, delete-orphan"
    )


class ETLRunLog(Base):
    __tablename__ = "etl_run_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    run_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("etl_runs.id", ondelete="CASCADE"), nullable=False
    )
    level: Mapped[str] = mapped_column(String(10), default="INFO")
    message: Mapped[str] = mapped_column(Text, nullable=False)
    step: Mapped[Optional[str]] = mapped_column(String(50))
    timestamp: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    extra: Mapped[Optional[dict]] = mapped_column(JSON)

    run: Mapped[ETLRun] = relationship("ETLRun", back_populates="logs")


class ExtractJob(Base):
    __tablename__ = "extract_jobs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    run_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("etl_runs.id", ondelete="CASCADE"), nullable=False
    )
    application_id: Mapped[str] = mapped_column(String(50), nullable=False)
    date: Mapped[str] = mapped_column(String(10), nullable=False)
    segment: Mapped[int] = mapped_column(Integer, nullable=False)
    total_segments: Mapped[Optional[int]] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(
        SAEnum(RunStatus), default=RunStatus.PENDING, nullable=False
    )
    records_count: Mapped[int] = mapped_column(BigInteger, default=0)
    output_path: Mapped[Optional[str]] = mapped_column(String(500))
    output_format: Mapped[str] = mapped_column(String(10), default="parquet")
    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    error_message: Mapped[Optional[str]] = mapped_column(Text)

    run: Mapped[ETLRun] = relationship("ETLRun", back_populates="extract_jobs")


class ServiceError(Base):
    __tablename__ = "service_errors"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    service: Mapped[str] = mapped_column(String(50), nullable=False)
    level: Mapped[str] = mapped_column(String(10), default="ERROR")
    message: Mapped[str] = mapped_column(Text, nullable=False)
    traceback: Mapped[Optional[str]] = mapped_column(Text)
    context: Mapped[Optional[dict]] = mapped_column(JSON)
    resolved: Mapped[bool] = mapped_column(Boolean, default=False)
    timestamp: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class PipelineDependency(Base):
    """Directed edge: pipeline_id depends on upstream_id completing first."""
    __tablename__ = "pipeline_dependencies"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    pipeline_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("etl_pipelines.id", ondelete="CASCADE"), nullable=False, index=True
    )
    upstream_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("etl_pipelines.id", ondelete="CASCADE"), nullable=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    pipeline: Mapped[ETLPipeline] = relationship(
        "ETLPipeline", foreign_keys=[pipeline_id], back_populates="dependencies"
    )
    upstream: Mapped[ETLPipeline] = relationship(
        "ETLPipeline", foreign_keys=[upstream_id], back_populates="dependents"
    )


class ExecutionContext(Base):
    """Platform-wide execution context: business date and namespace settings.
    Only one active row is used (id=1, upserted on every update).
    """
    __tablename__ = "execution_context"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    # The business date all jobs should operate on (YYYY-MM-DD)
    business_date: Mapped[Optional[str]] = mapped_column(String(10))
    # Prefix prepended to the business date to form the table namespace
    # e.g. "data_" → table namespace "data_20260414"
    namespace_prefix: Mapped[str] = mapped_column(String(100), default="data_")
    # Optional direct override for the Spark database name.
    # When set, this takes precedence over the prefix+date derived name.
    db_name: Mapped[Optional[str]] = mapped_column(String(200))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class NotebookFile(Base):
    """A stored Python notebook for use in transform jobs."""
    __tablename__ = "notebook_files"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False, unique=True)
    description: Mapped[Optional[str]] = mapped_column(Text)
    # JSON-serialised list of cells: [{type: "code"|"markdown", source: str}]
    cells: Mapped[list] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class TransformJobStatus(str, enum.Enum):
    IDLE = "idle"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


class TransformJob(Base):
    """A Transform & Load job: reads from a Spark catalog table, applies a
    SQL or notebook transform, and writes the result to a target table."""
    __tablename__ = "transform_jobs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False, unique=True)
    description: Mapped[Optional[str]] = mapped_column(Text)

    # Source: Spark catalog table (db.table)
    source_database: Mapped[Optional[str]] = mapped_column(String(200))
    source_table: Mapped[str] = mapped_column(String(200), nullable=False)

    # Transform type: "sql" | "notebook"
    transform_type: Mapped[str] = mapped_column(String(20), default="sql")
    # For SQL transforms: either inline SQL or reference to a SqlFile
    sql_content: Mapped[Optional[str]] = mapped_column(Text)
    sql_file_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("sql_files.id", ondelete="SET NULL")
    )
    # For notebook transforms: reference to a NotebookFile
    notebook_file_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("notebook_files.id", ondelete="SET NULL")
    )

    # Tags (list of strings stored as JSON)
    tags: Mapped[Optional[list]] = mapped_column(JSON, default=list)

    # Output target
    target_database: Mapped[Optional[str]] = mapped_column(String(200))
    target_table: Mapped[str] = mapped_column(String(200), nullable=False)
    target_mode: Mapped[str] = mapped_column(String(20), default="overwrite")

    # Run state
    status: Mapped[str] = mapped_column(
        SAEnum(TransformJobStatus), default=TransformJobStatus.IDLE, nullable=False
    )
    last_run_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    last_run_duration_s: Mapped[Optional[float]] = mapped_column(Float)
    last_run_rows: Mapped[Optional[int]] = mapped_column(BigInteger)
    last_error: Mapped[Optional[str]] = mapped_column(Text)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    sql_file: Mapped[Optional[SqlFile]] = relationship("SqlFile")
    notebook_file: Mapped[Optional[NotebookFile]] = relationship("NotebookFile")


class ETLChainStatus(str, enum.Enum):
    IDLE = "idle"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


class ETLChain(Base):
    """An ordered chain of ETL pipeline runs and/or Transform jobs.

    Steps are stored as a JSON list of objects::

        [
            {"type": "pipeline", "pipeline_id": 1},
            {"type": "transform", "transform_job_id": 3},
        ]

    Steps are executed sequentially; a failure halts the chain.
    """
    __tablename__ = "etl_chains"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False, unique=True)
    description: Mapped[Optional[str]] = mapped_column(Text)

    # Ordered list of step definitions (see class docstring)
    steps: Mapped[list] = mapped_column(JSON, default=list)

    # Last execution state
    status: Mapped[str] = mapped_column(
        SAEnum(ETLChainStatus), default=ETLChainStatus.IDLE, nullable=False
    )
    last_run_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    last_run_duration_s: Mapped[Optional[float]] = mapped_column(Float)
    last_error: Mapped[Optional[str]] = mapped_column(Text)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )



class ConnectionType(str, enum.Enum):
    JDBC = "jdbc"
    GRPC = "grpc"
    REST = "rest"
    OTHER = "other"


class Connection(Base):
    """Named, reusable connection configuration for ETL jobs.

    Passwords are stored Fernet-encrypted. The key comes from the
    ``CONNECTIONS_SECRET_KEY`` env var and must NEVER be committed.
    """
    __tablename__ = "connections"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False, unique=True)
    description: Mapped[Optional[str]] = mapped_column(Text)
    conn_type: Mapped[str] = mapped_column(
        SAEnum(ConnectionType), default=ConnectionType.JDBC, nullable=False
    )
    host: Mapped[Optional[str]] = mapped_column(String(500))
    port: Mapped[Optional[int]] = mapped_column(Integer)
    database: Mapped[Optional[str]] = mapped_column(String(200))
    username: Mapped[Optional[str]] = mapped_column(String(200))
    # Fernet-encrypted password, stored as base64 token string
    password_encrypted: Mapped[Optional[str]] = mapped_column(Text)
    # Extra params (e.g. JDBC driver class, SSL options)
    extra: Mapped[Optional[dict]] = mapped_column(JSON, default=dict)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
