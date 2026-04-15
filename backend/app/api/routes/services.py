from __future__ import annotations
import asyncio
import logging
import time
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter

from app.core.config import settings
from app.schemas.etl import ServiceInfo, ServicesStatus
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
