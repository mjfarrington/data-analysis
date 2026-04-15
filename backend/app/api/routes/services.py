from __future__ import annotations
import asyncio
import logging
import time
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter

from app.core.config import settings
from app.schemas.etl import ServiceInfo, ServicesStatus, SparkTestItem, SparkTestResult
from app.services.grpc_client import grpc_client
from app.services.spark_service import spark_service

router = APIRouter(prefix="/services", tags=["Services"])
logger = logging.getLogger(__name__)


async def _check_http(name: str, url: str, timeout: float = 5.0) -> ServiceInfo:
    t0 = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            r = await client.get(url)
            latency = (time.perf_counter() - t0) * 1000
            if r.status_code < 400:
                return ServiceInfo(
                    name=name,
                    status="healthy",
                    url=url,
                    latency_ms=round(latency, 2),
                    message=f"HTTP {r.status_code}",
                )
            return ServiceInfo(
                name=name,
                status="degraded",
                url=url,
                latency_ms=round(latency, 2),
                message=f"HTTP {r.status_code}",
            )
    except Exception as exc:
        return ServiceInfo(
            name=name,
            status="unhealthy",
            url=url,
            latency_ms=round((time.perf_counter() - t0) * 1000, 2),
            message=str(exc),
        )


async def _spark_master_details() -> dict:
    """Fetch worker core/memory totals from Spark Master REST API."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(f"{settings.SPARK_MASTER_WEBUI}/json/")
            if r.status_code == 200:
                d = r.json()
                return {
                    "cores_total": d.get("cores", 0),
                    "cores_used": d.get("coresused", 0),
                    "memory_total_mb": d.get("memory", 0),
                    "memory_used_mb": d.get("memoryused", 0),
                    "workers": d.get("aliveworkers", 0),
                    "active_apps": d.get("activeapps", 0) if isinstance(d.get("activeapps"), int) else len(d.get("activeapps", [])),
                    "spark_version": d.get("version"),
                }
    except Exception:
        pass
    return {}


@router.get("/status", response_model=ServicesStatus)
async def get_services_status():
    tasks = [
        _check_http("Spark Master", f"{settings.SPARK_MASTER_WEBUI}/api/v1/applications"),
        _check_http("Spark Worker", f"{settings.SPARK_WORKER_WEBUI}/json/"),
        _check_http("Spark History", f"{settings.SPARK_HISTORY_WEBUI}/api/v1/applications"),
        _spark_master_details(),
    ]

    *http_results, master_details = await asyncio.gather(*tasks, return_exceptions=True)
    services: list[ServiceInfo] = []
    for r in http_results:
        if isinstance(r, ServiceInfo):
            services.append(r)
        else:
            services.append(ServiceInfo(name="Unknown", status="unhealthy", message=str(r)))

    # Enrich Master entry with resource details
    if isinstance(master_details, dict) and master_details:
        for s in services:
            if s.name == "Spark Master":
                s.details = master_details
                break

    # Spark Connect check
    connect_result = await spark_service.test_connection()
    services.append(
        ServiceInfo(
            name="Spark Connect",
            status="healthy" if connect_result["connected"] else "unhealthy",
            url=settings.SPARK_CONNECT_URL,
            latency_ms=connect_result.get("latency_ms"),
            message=connect_result.get("message"),
        )
    )

    # gRPC extract service
    grpc_result = await grpc_client.test_connection()
    services.append(
        ServiceInfo(
            name="Data Extract gRPC",
            status="healthy" if grpc_result.get("connected") else "unhealthy",
            url=settings.grpc_address,
            latency_ms=grpc_result.get("latency_ms"),
            message=grpc_result.get("message"),
            details={
                "server_version": grpc_result.get("server_version"),
                "server_id": grpc_result.get("server_id"),
                "uptime_seconds": grpc_result.get("uptime_seconds"),
            },
        )
    )

    unhealthy = sum(1 for s in services if s.status == "unhealthy")
    degraded = sum(1 for s in services if s.status == "degraded")
    if unhealthy == 0 and degraded == 0:
        overall = "healthy"
    elif unhealthy >= len(services) // 2:
        overall = "unhealthy"
    else:
        overall = "degraded"

    return ServicesStatus(
        overall=overall,
        services=services,
        checked_at=datetime.now(timezone.utc),
    )


@router.get("/spark/master")
async def spark_master_status():
    return await spark_service.get_master_status()


@router.post("/spark/test-connection")
async def test_spark_connection():
    return await spark_service.test_connection()


@router.post("/services/spark/run-test", response_model=SparkTestResult)
@router.post("/spark/run-test", response_model=SparkTestResult)
async def run_spark_test():
    """Run a suite of Spark tests to validate the cluster is working correctly."""
    t_total = time.perf_counter()
    tests: list[SparkTestItem] = []
    spark_version: str | None = None
    catalog_tables: int | None = None

    # ── Test 1: Basic connectivity ────────────────────────────────────────────
    t0 = time.perf_counter()
    try:
        result = await spark_service.test_connection()
        dur = (time.perf_counter() - t0) * 1000
        if result["connected"]:
            tests.append(SparkTestItem(name="Connect — SELECT 1", status="passed", duration_ms=round(dur, 1), detail="Spark Connect responded ok"))
        else:
            tests.append(SparkTestItem(name="Connect — SELECT 1", status="failed", duration_ms=round(dur, 1), detail=result.get("message")))
    except Exception as exc:
        tests.append(SparkTestItem(name="Connect — SELECT 1", status="failed", duration_ms=round((time.perf_counter() - t0) * 1000, 1), detail=str(exc)))

    # ── Test 2: Spark version query ───────────────────────────────────────────
    t0 = time.perf_counter()
    try:
        def _version():
            from app.services.spark_service import _get_spark
            spark = _get_spark()
            row = spark.sql("SELECT version() AS v").collect()[0]
            return row["v"]
        ver = await asyncio.to_thread(_version)
        spark_version = ver
        dur = (time.perf_counter() - t0) * 1000
        tests.append(SparkTestItem(name="Spark version()", status="passed", duration_ms=round(dur, 1), detail=ver))
    except Exception as exc:
        tests.append(SparkTestItem(name="Spark version()", status="failed", duration_ms=round((time.perf_counter() - t0) * 1000, 1), detail=str(exc)))

    # ── Test 3: In-memory DataFrame computation ───────────────────────────────
    t0 = time.perf_counter()
    try:
        def _compute():
            from app.services.spark_service import _get_spark
            spark = _get_spark()
            df = spark.range(0, 10_000)
            return df.selectExpr("sum(id) as total").collect()[0]["total"]
        total = await asyncio.to_thread(_compute)
        dur = (time.perf_counter() - t0) * 1000
        tests.append(SparkTestItem(name="Executor compute (SUM 0–9999)", status="passed", duration_ms=round(dur, 1), detail=f"sum = {total:,}"))
    except Exception as exc:
        tests.append(SparkTestItem(name="Executor compute (SUM 0–9999)", status="failed", duration_ms=round((time.perf_counter() - t0) * 1000, 1), detail=str(exc)))

    # ── Test 4: Catalog / warehouse ───────────────────────────────────────────
    t0 = time.perf_counter()
    try:
        def _catalog():
            from app.services.spark_service import _get_spark
            spark = _get_spark()
            tables = spark.sql("SHOW TABLES").collect()
            return len(tables)
        n = await asyncio.to_thread(_catalog)
        catalog_tables = n
        dur = (time.perf_counter() - t0) * 1000
        tests.append(SparkTestItem(name="Catalog — SHOW TABLES", status="passed", duration_ms=round(dur, 1), detail=f"{n} table(s) in warehouse"))
    except Exception as exc:
        tests.append(SparkTestItem(name="Catalog — SHOW TABLES", status="failed", duration_ms=round((time.perf_counter() - t0) * 1000, 1), detail=str(exc)))

    # ── Test 5: Parquet read (if any data exists) ─────────────────────────────
    t0 = time.perf_counter()
    try:
        import os
        parquet_root = settings.parquet_path
        parquet_files = list(parquet_root.rglob("*.parquet"))[:1]
        if parquet_files:
            def _read():
                from app.services.spark_service import _get_spark
                spark = _get_spark()
                df = spark.read.parquet(str(parquet_files[0]))
                return df.count(), len(df.columns)
            rows, cols = await asyncio.to_thread(_read)
            dur = (time.perf_counter() - t0) * 1000
            tests.append(SparkTestItem(name="Parquet read (sample file)", status="passed", duration_ms=round(dur, 1), detail=f"{rows:,} rows × {cols} cols"))
        else:
            tests.append(SparkTestItem(name="Parquet read (sample file)", status="skipped", duration_ms=0, detail="No parquet files found in data/parquet/"))
    except Exception as exc:
        tests.append(SparkTestItem(name="Parquet read (sample file)", status="failed", duration_ms=round((time.perf_counter() - t0) * 1000, 1), detail=str(exc)))

    total_ms = round((time.perf_counter() - t_total) * 1000, 1)
    failed = any(t.status == "failed" for t in tests)
    return SparkTestResult(
        overall="failed" if failed else "passed",
        tests=tests,
        total_ms=total_ms,
        spark_version=spark_version,
        catalog_tables=catalog_tables,
    )


@router.get("/grpc/status")
async def grpc_service_status():
    return await grpc_client.get_service_status()


@router.post("/grpc/test-connection")
async def test_grpc_connection():
    return await grpc_client.test_connection()



async def _check_http(name: str, url: str, timeout: float = 5.0) -> ServiceInfo:
    t0 = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            r = await client.get(url)
            latency = (time.perf_counter() - t0) * 1000
            if r.status_code < 400:
                return ServiceInfo(
                    name=name,
                    status="healthy",
                    url=url,
                    latency_ms=round(latency, 2),
                    message=f"HTTP {r.status_code}",
                )
            return ServiceInfo(
                name=name,
                status="degraded",
                url=url,
                latency_ms=round(latency, 2),
                message=f"HTTP {r.status_code}",
            )
    except Exception as exc:
        return ServiceInfo(
            name=name,
            status="unhealthy",
            url=url,
            latency_ms=round((time.perf_counter() - t0) * 1000, 2),
            message=str(exc),
        )


@router.get("/status", response_model=ServicesStatus)
async def get_services_status():
    tasks = [
        _check_http(
            "Spark Master",
            f"{settings.SPARK_MASTER_WEBUI}/api/v1/applications",
        ),
        _check_http(
            "Spark Worker",
            f"{settings.SPARK_WORKER_WEBUI}/json/",
        ),
        _check_http(
            "Spark History",
            f"{settings.SPARK_HISTORY_WEBUI}/api/v1/applications",
        ),
    ]

    results = await asyncio.gather(*tasks, return_exceptions=True)
    services: list[ServiceInfo] = []
    for r in results:
        if isinstance(r, ServiceInfo):
            services.append(r)
        else:
            services.append(
                ServiceInfo(name="Unknown", status="unhealthy", message=str(r))
            )

    # Spark Connect check
    connect_result = await spark_service.test_connection()
    services.append(
        ServiceInfo(
            name="Spark Connect",
            status="healthy" if connect_result["connected"] else "unhealthy",
            url=settings.SPARK_CONNECT_URL,
            latency_ms=connect_result.get("latency_ms"),
            message=connect_result.get("message"),
        )
    )

    # gRPC extract service
    grpc_result = await grpc_client.test_connection()
    services.append(
        ServiceInfo(
            name="Data Extract gRPC",
            status="healthy" if grpc_result.get("connected") else "unhealthy",
            url=settings.grpc_address,
            latency_ms=grpc_result.get("latency_ms"),
            message=grpc_result.get("message"),
            details={
                "server_version": grpc_result.get("server_version"),
                "server_id": grpc_result.get("server_id"),
                "uptime_seconds": grpc_result.get("uptime_seconds"),
            },
        )
    )

    unhealthy = sum(1 for s in services if s.status == "unhealthy")
    degraded = sum(1 for s in services if s.status == "degraded")
    if unhealthy == 0 and degraded == 0:
        overall = "healthy"
    elif unhealthy >= len(services) // 2:
        overall = "unhealthy"
    else:
        overall = "degraded"

    return ServicesStatus(
        overall=overall,
        services=services,
        checked_at=datetime.now(timezone.utc),
    )


@router.get("/spark/master")
async def spark_master_status():
    return await spark_service.get_master_status()


@router.post("/spark/test-connection")
async def test_spark_connection():
    return await spark_service.test_connection()


@router.get("/grpc/status")
async def grpc_service_status():
    status = await grpc_client.get_service_status()
    return status


@router.post("/grpc/test-connection")
async def test_grpc_connection():
    return await grpc_client.test_connection()
