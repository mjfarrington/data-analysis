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


class SqlFile(Base):
    __tablename__ = "sql_files"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False, unique=True)
    description: Mapped[Optional[str]] = mapped_column(Text)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


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
    # e.g. "markets_" → table namespace "markets_20260414"
    namespace_prefix: Mapped[str] = mapped_column(String(100), default="")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
