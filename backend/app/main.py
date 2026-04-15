"""
FastAPI application entry point.
"""
from __future__ import annotations

import asyncio
import logging.config
import time
from contextlib import asynccontextmanager
from typing import AsyncGenerator

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.core.config import settings
from app.core.database import init_db
from app.api.routes import etl, services, data
from app.services.etl_engine import get_broadcast_queue

# ─────────────────────────────────────────────────────────────────────────────
# Logging
# ─────────────────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=getattr(logging, settings.LOG_LEVEL),
    format="%(asctime)s [%(levelname)-8s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Lifespan
# ─────────────────────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator:
    logger.info("Starting %s v%s", settings.APP_NAME, settings.APP_VERSION)
    await init_db()
    # Start log broadcast relay task
    app.state.broadcast_task = asyncio.create_task(_broadcast_relay())
    yield
    app.state.broadcast_task.cancel()
    logger.info("Shutdown complete")


# ─────────────────────────────────────────────────────────────────────────────
# WebSocket log relay
# ─────────────────────────────────────────────────────────────────────────────
_ws_clients: dict[int | None, list[WebSocket]] = {}  # run_id -> [ws, ...]


async def _broadcast_relay() -> None:
    """Pull from ETL engine queue and push to subscribed WebSocket clients."""
    queue = get_broadcast_queue()
    while True:
        try:
            log_entry = await queue.get()
            run_id = log_entry.get("run_id")
            to_remove: list[tuple[int | None, WebSocket]] = []
            for key in (run_id, None):  # None = global subscribers
                for ws in _ws_clients.get(key, []):
                    try:
                        await ws.send_json(log_entry)
                    except Exception:
                        to_remove.append((key, ws))
            for key, ws in to_remove:
                clients = _ws_clients.get(key, [])
                if ws in clients:
                    clients.remove(ws)
        except asyncio.CancelledError:
            break
        except Exception as exc:
            logger.debug("Broadcast relay error: %s", exc)


# ─────────────────────────────────────────────────────────────────────────────
# App factory
# ─────────────────────────────────────────────────────────────────────────────
app = FastAPI(
    title=settings.APP_NAME,
    version=settings.APP_VERSION,
    docs_url="/docs",
    redoc_url="/redoc",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount routers
app.include_router(etl.router, prefix=settings.API_PREFIX)
app.include_router(services.router, prefix=settings.API_PREFIX)
app.include_router(data.router, prefix=settings.API_PREFIX)


# ─────────────────────────────────────────────────────────────────────────────
# Health & root
# ─────────────────────────────────────────────────────────────────────────────
_start_time = time.monotonic()


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "app": settings.APP_NAME,
        "version": settings.APP_VERSION,
        "uptime_seconds": round(time.monotonic() - _start_time),
    }


@app.get("/")
async def root():
    return {"message": settings.APP_NAME, "docs": "/docs"}


# ─────────────────────────────────────────────────────────────────────────────
# WebSocket endpoints
# ─────────────────────────────────────────────────────────────────────────────
@app.websocket("/ws/logs")
async def ws_logs_global(ws: WebSocket):
    """Subscribe to all ETL run logs."""
    await ws.accept()
    _ws_clients.setdefault(None, []).append(ws)
    try:
        while True:
            await ws.receive_text()  # keep connection alive
    except WebSocketDisconnect:
        clients = _ws_clients.get(None, [])
        if ws in clients:
            clients.remove(ws)


@app.websocket("/ws/logs/{run_id}")
async def ws_logs_run(ws: WebSocket, run_id: int):
    """Subscribe to logs for a specific ETL run."""
    await ws.accept()
    _ws_clients.setdefault(run_id, []).append(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        clients = _ws_clients.get(run_id, [])
        if ws in clients:
            clients.remove(ws)


@app.websocket("/ws/status")
async def ws_status(ws: WebSocket):
    """Push service status every 10 seconds."""
    await ws.accept()
    try:
        while True:
            from app.api.routes.services import get_services_status
            status = await get_services_status()
            await ws.send_json(status.model_dump(mode="json"))
            await asyncio.sleep(10)
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.debug("Status WS error: %s", exc)
