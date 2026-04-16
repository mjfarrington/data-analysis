"""
Connections API — CRUD for named, reusable connection configs.
Passwords are stored Fernet-encrypted; they are never returned in responses.
"""
from __future__ import annotations

import logging
import time

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.etl import Connection
from app.schemas.etl import (
    ConnectionCreate, ConnectionUpdate, ConnectionResponse, ConnectionTestResult,
)
from app.services.crypto import encrypt_password, decrypt_password

router = APIRouter(prefix="/connections", tags=["Connections"])
logger = logging.getLogger(__name__)


def _to_response(conn: Connection) -> ConnectionResponse:
    return ConnectionResponse(
        id=conn.id,
        name=conn.name,
        description=conn.description,
        conn_type=conn.conn_type,
        host=conn.host,
        port=conn.port,
        database=conn.database,
        username=conn.username,
        has_password=bool(conn.password_encrypted),
        extra=conn.extra,
        created_at=conn.created_at,
        updated_at=conn.updated_at,
    )


@router.get("", response_model=list[ConnectionResponse])
async def list_connections(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Connection).order_by(Connection.name))
    return [_to_response(c) for c in result.scalars().all()]


@router.post("", response_model=ConnectionResponse, status_code=201)
async def create_connection(data: ConnectionCreate, db: AsyncSession = Depends(get_db)):
    # Check uniqueness
    existing = await db.execute(select(Connection).where(Connection.name == data.name))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail=f"Connection '{data.name}' already exists")

    encrypted = encrypt_password(data.password) if data.password else None
    conn = Connection(
        name=data.name,
        description=data.description,
        conn_type=data.conn_type,
        host=data.host,
        port=data.port,
        database=data.database,
        username=data.username,
        password_encrypted=encrypted,
        extra=data.extra or {},
    )
    db.add(conn)
    await db.commit()
    await db.refresh(conn)
    return _to_response(conn)


@router.get("/{conn_id}", response_model=ConnectionResponse)
async def get_connection(conn_id: int, db: AsyncSession = Depends(get_db)):
    conn = await db.get(Connection, conn_id)
    if not conn:
        raise HTTPException(status_code=404, detail="Connection not found")
    return _to_response(conn)


@router.put("/{conn_id}", response_model=ConnectionResponse)
async def update_connection(conn_id: int, data: ConnectionUpdate, db: AsyncSession = Depends(get_db)):
    conn = await db.get(Connection, conn_id)
    if not conn:
        raise HTTPException(status_code=404, detail="Connection not found")

    if data.name is not None:
        # Check uniqueness on rename
        existing = await db.execute(
            select(Connection).where(Connection.name == data.name, Connection.id != conn_id)
        )
        if existing.scalar_one_or_none():
            raise HTTPException(status_code=409, detail=f"Connection '{data.name}' already exists")
        conn.name = data.name

    for field in ("description", "conn_type", "host", "port", "database", "username", "extra"):
        val = getattr(data, field)
        if val is not None:
            setattr(conn, field, val)

    if data.password is not None:
        # Empty string clears the password; any other value updates it
        conn.password_encrypted = encrypt_password(data.password) if data.password else None

    await db.commit()
    await db.refresh(conn)
    return _to_response(conn)


@router.delete("/{conn_id}", status_code=204)
async def delete_connection(conn_id: int, db: AsyncSession = Depends(get_db)):
    conn = await db.get(Connection, conn_id)
    if not conn:
        raise HTTPException(status_code=404, detail="Connection not found")
    await db.delete(conn)
    await db.commit()


@router.post("/{conn_id}/test", response_model=ConnectionTestResult)
async def test_connection(conn_id: int, db: AsyncSession = Depends(get_db)):
    """Attempt to connect using the stored credentials and return a result."""
    conn = await db.get(Connection, conn_id)
    if not conn:
        raise HTTPException(status_code=404, detail="Connection not found")

    t0 = time.perf_counter()

    if conn.conn_type == "jdbc":
        try:
            from sqlalchemy import create_engine, text  # type: ignore
            password = decrypt_password(conn.password_encrypted) if conn.password_encrypted else ""
            # Build URL: host:port/database with optional user:pass
            url = (conn.extra or {}).get("jdbc_url") or _build_jdbc_url(conn, password)
            engine = create_engine(url, pool_pre_ping=True, pool_size=1)
            with engine.connect() as c:
                c.execute(text("SELECT 1"))
            latency = (time.perf_counter() - t0) * 1000
            return ConnectionTestResult(success=True, message="Connection successful", latency_ms=round(latency, 2))
        except Exception as exc:
            return ConnectionTestResult(success=False, message=str(exc))

    elif conn.conn_type == "grpc":
        from app.services.grpc_client import grpc_client
        try:
            ok = await grpc_client.ping()
            latency = (time.perf_counter() - t0) * 1000
            return ConnectionTestResult(success=ok, message="gRPC ping OK" if ok else "gRPC ping failed", latency_ms=round(latency, 2))
        except Exception as exc:
            return ConnectionTestResult(success=False, message=str(exc))

    else:
        return ConnectionTestResult(success=False, message=f"Test not supported for type '{conn.conn_type}'")


def _build_jdbc_url(conn: Connection, password: str) -> str:
    """Build a minimal SQLAlchemy JDBC URL from individual fields."""
    if conn.host:
        user_pass = f"{conn.username}:{password}@" if conn.username else ""
        db_part = f"/{conn.database}" if conn.database else ""
        port_part = f":{conn.port}" if conn.port else ""
        return f"postgresql+psycopg2://{user_pass}{conn.host}{port_part}{db_part}"
    return ""
