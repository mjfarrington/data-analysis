"""
gRPC client for the Data Extract Service.
Handles connection management, retries, and streaming.
"""
from __future__ import annotations

import asyncio
import logging
import time
from contextlib import asynccontextmanager
from typing import AsyncIterator, Iterator

import grpc

from app.core.config import settings

logger = logging.getLogger(__name__)

# Lazy import for generated stubs
def _imports():
    import sys
    from pathlib import Path
    grpc_path = str(Path(__file__).parents[3] / "grpc")
    if grpc_path not in sys.path:
        sys.path.insert(0, grpc_path)
    from generated import data_extract_pb2 as pb2        # type: ignore
    from generated import data_extract_pb2_grpc as pb2_grpc  # type: ignore
    return pb2, pb2_grpc


class GrpcClient:
    def __init__(self) -> None:
        self._channel: grpc.Channel | None = None
        self._stub = None
        self._pb2 = None
        self._pb2_grpc = None

    def _ensure_stubs(self):
        if self._pb2 is None:
            self._pb2, self._pb2_grpc = _imports()

    def _get_channel(self) -> grpc.Channel:
        if self._channel is None:
            opts = [
                ("grpc.max_send_message_length", settings.GRPC_MAX_MESSAGE_MB * 1024 * 1024),
                ("grpc.max_receive_message_length", settings.GRPC_MAX_MESSAGE_MB * 1024 * 1024),
                ("grpc.keepalive_time_ms", 30_000),
                ("grpc.keepalive_timeout_ms", 10_000),
            ]
            self._channel = grpc.insecure_channel(settings.grpc_address, options=opts)
        return self._channel

    def _get_stub(self):
        self._ensure_stubs()
        if self._stub is None:
            self._stub = self._pb2_grpc.DataExtractServiceStub(self._get_channel())
        return self._stub

    def close(self) -> None:
        if self._channel:
            self._channel.close()
            self._channel = None
            self._stub = None

    # ─────────────────────────────────────────────────────────────────────
    # Async wrappers
    # ─────────────────────────────────────────────────────────────────────
    async def test_connection(self) -> dict:
        t0 = time.perf_counter()
        try:
            pb2, _ = _imports()
            stub = self._get_stub()
            response = await asyncio.to_thread(
                stub.TestConnection,
                pb2.Empty(),
                timeout=settings.GRPC_TIMEOUT,
            )
            latency_ms = (time.perf_counter() - t0) * 1000
            return {
                "connected": response.connected,
                "message": response.message,
                "server_version": response.server_version,
                "server_id": response.server_id,
                "uptime_seconds": response.uptime_seconds,
                "latency_ms": round(latency_ms, 2),
            }
        except grpc.RpcError as exc:
            return {
                "connected": False,
                "message": f"gRPC error: {exc.code()} — {exc.details()}",
                "latency_ms": round((time.perf_counter() - t0) * 1000, 2),
            }
        except Exception as exc:
            return {
                "connected": False,
                "message": str(exc),
                "latency_ms": round((time.perf_counter() - t0) * 1000, 2),
            }

    async def get_service_status(self) -> dict:
        try:
            pb2, _ = _imports()
            stub = self._get_stub()
            resp = await asyncio.to_thread(
                stub.GetServiceStatus,
                pb2.Empty(),
                timeout=settings.GRPC_TIMEOUT,
            )
            return {
                "healthy": resp.healthy,
                "active_connections": resp.active_connections,
                "total_records_served": resp.total_records_served,
                "total_extractions": resp.total_extractions,
                "avg_response_time_ms": resp.avg_response_time_ms,
                "records_per_second": resp.records_per_second,
                "server_version": resp.server_version,
                "available_apps": [
                    {
                        "application_id": a.application_id,
                        "earliest_date": a.earliest_date,
                        "latest_date": a.latest_date,
                        "total_records": a.total_records,
                        "segment_count": a.segment_count,
                    }
                    for a in resp.available_apps
                ],
            }
        except Exception as exc:
            return {"healthy": False, "message": str(exc)}

    async def list_available_data(
        self, application_id: str = "", from_date: str = "", to_date: str = ""
    ) -> list[dict]:
        try:
            pb2, _ = _imports()
            stub = self._get_stub()
            req = pb2.ListRequest(
                application_id=application_id,
                from_date=from_date,
                to_date=to_date,
            )
            resp = await asyncio.to_thread(stub.ListAvailableData, req, timeout=10.0)
            return [
                {
                    "application_id": a.application_id,
                    "earliest_date": a.earliest_date,
                    "latest_date": a.latest_date,
                    "total_records": a.total_records,
                    "segment_count": a.segment_count,
                }
                for a in resp.apps
            ]
        except Exception as exc:
            logger.error("list_available_data failed: %s", exc)
            return []

    async def extract_segment(
        self,
        app_id: str,
        date: str,
        segment: int,
        page_size: int = 10_000,
    ) -> dict:
        """Extract a single segment, return as dict with records list."""
        def _do_extract():
            pb2, _ = _imports()
            stub = self._get_stub()
            req = pb2.ExtractRequest(
                application_id=app_id,
                date=date,
                segment=segment,
                page_size=page_size,
            )
            chunks = list(stub.ExtractData(req, timeout=settings.GRPC_TIMEOUT))
            if not chunks:
                return {"records": [], "total_segments": 1, "is_last": True, "total_records": 0}
            chunk = chunks[0]
            records = [
                {
                    "id": r.id,
                    "application_id": r.application_id,
                    "date": r.date,
                    "segment": r.segment,
                    "entity_type": r.entity_type,
                    "entity_id": r.entity_id,
                    "status": r.status,
                    "value": r.value,
                    "currency": r.currency,
                    "category": r.category,
                    "region": r.region,
                    "created_at": r.created_at,
                    "updated_at": r.updated_at,
                    **{f"attr_{k}": v for k, v in r.attributes.items()},
                }
                for r in chunk.records
            ]
            return {
                "records": records,
                "total_segments": chunk.total_segments,
                "is_last": chunk.is_last,
                "total_records": chunk.total_records,
                "segment_records": chunk.segment_records,
                "extract_id": chunk.metadata.extract_id if chunk.metadata else "",
            }

        return await asyncio.to_thread(_do_extract)

    async def extract_all_segments(
        self,
        app_id: str,
        date: str,
        page_size: int = 10_000,
    ) -> AsyncIterator[dict]:
        """Async generator yielding each segment as it arrives."""
        def _stream():
            pb2, _ = _imports()
            stub = self._get_stub()
            req = pb2.ExtractAllRequest(
                application_id=app_id,
                date=date,
                page_size=page_size,
            )
            for chunk in stub.ExtractAllSegments(req, timeout=300.0):
                records = [
                    {
                        "id": r.id,
                        "application_id": r.application_id,
                        "date": r.date,
                        "segment": r.segment,
                        "entity_type": r.entity_type,
                        "entity_id": r.entity_id,
                        "status": r.status,
                        "value": r.value,
                        "currency": r.currency,
                        "category": r.category,
                        "region": r.region,
                        "created_at": r.created_at,
                        "updated_at": r.updated_at,
                        **{f"attr_{k}": v for k, v in r.attributes.items()},
                    }
                    for r in chunk.records
                ]
                yield {
                    "segment": chunk.segment,
                    "total_segments": chunk.total_segments,
                    "is_last": chunk.is_last,
                    "total_records": chunk.total_records,
                    "segment_records": chunk.segment_records,
                    "records": records,
                }

        # Run the sync generator in a thread, yield results back
        loop = asyncio.get_event_loop()
        queue: asyncio.Queue = asyncio.Queue()
        sentinel = object()

        def _producer():
            try:
                for item in _stream():
                    asyncio.run_coroutine_threadsafe(queue.put(item), loop).result()
            finally:
                asyncio.run_coroutine_threadsafe(queue.put(sentinel), loop).result()

        asyncio.get_event_loop().run_in_executor(None, _producer)

        while True:
            item = await queue.get()
            if item is sentinel:
                break
            yield item


grpc_client = GrpcClient()
