#!/usr/bin/env python3
"""
Dummy gRPC Data Extract Service
Simulates a bespoke data API returning records by application_id + date + segment.
"""
from __future__ import annotations

import asyncio
import logging
import math
import random
import time
import uuid
from concurrent import futures
from datetime import datetime, timedelta, timezone
from typing import Iterator

import grpc

# Generated stubs (run generate_protos.sh first)
try:
    from generated import data_extract_pb2 as pb2
    from generated import data_extract_pb2_grpc as pb2_grpc
except ImportError:
    raise ImportError(
        "gRPC stubs not found. Run: cd grpc && ./generate_protos.sh"
    )

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("data-extract-server")

# ─────────────────────────────────────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────────────────────────────────────
SERVER_PORT = 50051
SERVER_VERSION = "1.0.0-dummy"
SERVER_ID = f"dummy-{uuid.uuid4().hex[:8]}"
SERVER_START = time.monotonic()

# Simulate available applications and date range
APP_IDS = [f"APP{str(i).zfill(3)}" for i in range(1, 21)]
DATE_START = datetime(2024, 1, 1)
DATE_END = datetime(2025, 12, 31)

# Stats counters
_stats = {
    "connections": 0,
    "total_records": 0,
    "total_extractions": 0,
    "response_times": [],
}

ENTITY_TYPES = ["TRANSACTION", "CLAIM", "POLICY", "PAYMENT", "REFUND", "ADJUSTMENT"]
STATUSES = ["ACTIVE", "PENDING", "COMPLETED", "FAILED", "CANCELLED", "PROCESSING"]
CURRENCIES = ["GBP", "USD", "EUR", "JPY", "CHF"]
CATEGORIES = ["RETAIL", "WHOLESALE", "DIGITAL", "SERVICE", "SUBSCRIPTION"]
REGIONS = ["NORTH", "SOUTH", "EAST", "WEST", "CENTRAL", "OVERSEAS"]


# ─────────────────────────────────────────────────────────────────────────────
# Data Generation Helpers
# ─────────────────────────────────────────────────────────────────────────────
def _seed_for(app_id: str, date: str, segment: int) -> int:
    """Deterministic seed so same request always returns same data."""
    return hash(f"{app_id}:{date}:{segment}") & 0x7FFFFFFF


def _segment_count_for(app_id: str, date: str) -> int:
    """Return consistent segment count (3–8) for an app+date."""
    rng = random.Random(hash(f"{app_id}:{date}") & 0x7FFFFFFF)
    return rng.randint(3, 8)


def _records_in_segment(app_id: str, date: str, segment: int, page_size: int) -> int:
    """Return the number of records in a given segment."""
    rng = random.Random(_seed_for(app_id, date, segment))
    # Between 80% and 100% of page_size, except last segment may be partial
    total_segs = _segment_count_for(app_id, date)
    if segment == total_segs - 1:
        return rng.randint(int(page_size * 0.1), page_size)
    return rng.randint(int(page_size * 0.8), page_size)


def _generate_record(
    app_id: str,
    date: str,
    segment: int,
    idx: int,
    rng: random.Random,
) -> pb2.Record:
    record_id = f"{app_id}-{date}-S{segment:02d}-{idx:06d}"
    entity_type = rng.choice(ENTITY_TYPES)
    created_dt = datetime.fromisoformat(date) + timedelta(
        hours=rng.randint(0, 23),
        minutes=rng.randint(0, 59),
        seconds=rng.randint(0, 59),
    )
    return pb2.Record(
        id=record_id,
        application_id=app_id,
        date=date,
        segment=segment,
        entity_type=entity_type,
        entity_id=f"{entity_type[:3]}-{rng.randint(100000, 999999)}",
        status=rng.choice(STATUSES),
        value=round(rng.uniform(0.01, 100_000.0), 2),
        currency=rng.choice(CURRENCIES),
        category=rng.choice(CATEGORIES),
        region=rng.choice(REGIONS),
        created_at=created_dt.isoformat(),
        updated_at=(created_dt + timedelta(hours=rng.randint(0, 48))).isoformat(),
        attributes={
            "source": f"SYSTEM_{rng.randint(1, 5)}",
            "priority": rng.choice(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
            "batch_id": f"BATCH-{rng.randint(1000, 9999)}",
            "reference": f"REF-{rng.randint(10000, 99999)}",
        },
    )


def _generate_chunk(
    app_id: str,
    date: str,
    segment: int,
    page_size: int,
) -> pb2.DataChunk:
    t0 = time.perf_counter()
    rng = random.Random(_seed_for(app_id, date, segment))
    total_segs = _segment_count_for(app_id, date)
    n_records = _records_in_segment(app_id, date, segment, page_size)

    records = [
        _generate_record(app_id, date, segment, i, rng)
        for i in range(n_records)
    ]

    # Total records across all segments (approximation for realism)
    total_records = sum(
        _records_in_segment(app_id, date, s, page_size)
        for s in range(total_segs)
    )

    latency_ms = (time.perf_counter() - t0) * 1000

    # Add simulated network latency
    time.sleep(random.uniform(0.005, 0.05))

    return pb2.DataChunk(
        application_id=app_id,
        date=date,
        segment=segment,
        total_segments=total_segs,
        is_last=(segment == total_segs - 1),
        total_records=total_records,
        segment_records=n_records,
        records=records,
        metadata=pb2.ChunkMetadata(
            extract_id=str(uuid.uuid4()),
            server_version=SERVER_VERSION,
            timestamp_ms=int(time.time() * 1000),
            latency_ms=latency_ms,
        ),
    )


# ─────────────────────────────────────────────────────────────────────────────
# Service Implementation
# ─────────────────────────────────────────────────────────────────────────────
class DataExtractServicer(pb2_grpc.DataExtractServiceServicer):

    def TestConnection(
        self, request: pb2.Empty, context: grpc.ServicerContext
    ) -> pb2.ConnectionStatus:
        _stats["connections"] += 1
        uptime = int(time.monotonic() - SERVER_START)
        logger.info("TestConnection called — uptime=%ds", uptime)
        return pb2.ConnectionStatus(
            connected=True,
            message="Dummy Data Extract Service is running",
            server_version=SERVER_VERSION,
            server_id=SERVER_ID,
            uptime_seconds=uptime,
        )

    def GetServiceStatus(
        self, request: pb2.Empty, context: grpc.ServicerContext
    ) -> pb2.ServiceStatus:
        avg_rt = (
            sum(_stats["response_times"]) / len(_stats["response_times"])
            if _stats["response_times"]
            else 0.0
        )
        rps = _stats["total_records"] / max(time.monotonic() - SERVER_START, 1)

        app_infos = []
        for app_id in APP_IDS[:5]:  # return a sample
            seg_count = _segment_count_for(app_id, "2025-01-01")
            app_infos.append(
                pb2.AppDataInfo(
                    application_id=app_id,
                    earliest_date=DATE_START.strftime("%Y-%m-%d"),
                    latest_date=DATE_END.strftime("%Y-%m-%d"),
                    total_records=random.randint(100_000, 10_000_000),
                    segment_count=seg_count,
                )
            )

        return pb2.ServiceStatus(
            healthy=True,
            active_connections=_stats["connections"],
            total_records_served=_stats["total_records"],
            total_extractions=_stats["total_extractions"],
            avg_response_time_ms=avg_rt,
            records_per_second=rps,
            server_version=SERVER_VERSION,
            available_apps=app_infos,
        )

    def ListAvailableData(
        self, request: pb2.ListRequest, context: grpc.ServicerContext
    ) -> pb2.ListResponse:
        apps = APP_IDS
        if request.application_id:
            apps = [a for a in apps if a == request.application_id]

        infos = [
            pb2.AppDataInfo(
                application_id=app_id,
                earliest_date=DATE_START.strftime("%Y-%m-%d"),
                latest_date=DATE_END.strftime("%Y-%m-%d"),
                total_records=random.randint(500_000, 50_000_000),
                segment_count=_segment_count_for(app_id, "2025-01-01"),
            )
            for app_id in apps
        ]
        return pb2.ListResponse(apps=infos)

    def ExtractData(
        self, request: pb2.ExtractRequest, context: grpc.ServicerContext
    ) -> Iterator[pb2.DataChunk]:
        t0 = time.perf_counter()
        app_id = request.application_id or "APP001"
        date = request.date or datetime.now().strftime("%Y-%m-%d")
        segment = request.segment
        page_size = request.page_size or 10_000

        logger.info(
            "ExtractData: app=%s date=%s segment=%d page_size=%d",
            app_id, date, segment, page_size,
        )
        _stats["total_extractions"] += 1

        try:
            chunk = _generate_chunk(app_id, date, segment, page_size)
            _stats["total_records"] += chunk.segment_records
            _stats["response_times"].append((time.perf_counter() - t0) * 1000)
            if len(_stats["response_times"]) > 1000:
                _stats["response_times"] = _stats["response_times"][-500:]
            yield chunk
        except Exception as exc:
            logger.exception("ExtractData failed: %s", exc)
            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(str(exc))

    def ExtractAllSegments(
        self, request: pb2.ExtractAllRequest, context: grpc.ServicerContext
    ) -> Iterator[pb2.DataChunk]:
        app_id = request.application_id or "APP001"
        date = request.date or datetime.now().strftime("%Y-%m-%d")
        page_size = request.page_size or 10_000
        total_segs = _segment_count_for(app_id, date)

        logger.info(
            "ExtractAllSegments: app=%s date=%s total_segments=%d",
            app_id, date, total_segs,
        )

        for seg in range(total_segs):
            if context.is_active() is False:
                logger.warning("Client disconnected, aborting extraction")
                break
            t0 = time.perf_counter()
            chunk = _generate_chunk(app_id, date, seg, page_size)
            _stats["total_records"] += chunk.segment_records
            _stats["total_extractions"] += 1
            _stats["response_times"].append((time.perf_counter() - t0) * 1000)
            yield chunk


# ─────────────────────────────────────────────────────────────────────────────
# Server Bootstrap
# ─────────────────────────────────────────────────────────────────────────────
def serve(port: int = SERVER_PORT) -> None:
    server = grpc.server(
        futures.ThreadPoolExecutor(max_workers=20),
        options=[
            ("grpc.max_send_message_length", 64 * 1024 * 1024),
            ("grpc.max_receive_message_length", 64 * 1024 * 1024),
            ("grpc.keepalive_time_ms", 30_000),
            ("grpc.keepalive_timeout_ms", 10_000),
        ],
    )
    pb2_grpc.add_DataExtractServiceServicer_to_server(DataExtractServicer(), server)

    addr = f"[::]:{port}"
    server.add_insecure_port(addr)
    server.start()
    logger.info("Dummy Data Extract gRPC server started on %s", addr)
    logger.info("Server ID: %s  Version: %s", SERVER_ID, SERVER_VERSION)
    logger.info("Available apps: %s", ", ".join(APP_IDS))
    try:
        server.wait_for_termination()
    except KeyboardInterrupt:
        logger.info("Shutting down...")
        server.stop(grace=5)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Dummy Data Extract gRPC Server")
    parser.add_argument("--port", type=int, default=SERVER_PORT)
    args = parser.parse_args()
    serve(args.port)
