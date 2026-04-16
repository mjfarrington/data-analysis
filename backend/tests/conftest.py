"""
Shared pytest fixtures for the data-analysis backend test suite.

Provides:
  client         — async httpx client backed by an isolated in-memory SQLite DB.
  spark_required — pytest mark that skips a test when Spark Connect is offline.
"""
from __future__ import annotations

import pytest
import httpx
from unittest.mock import AsyncMock, patch
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession

from app.core.database import Base, get_db
from app.main import app
from app.services.spark_service import spark_service


# ─── Spark availability helper ─────────────────────────────────────────────────

def _spark_reachable() -> bool:
    """Return True iff a live Spark Connect server is accessible."""
    try:
        from app.services.spark_service import _get_spark
        _get_spark().sql("SELECT 1").collect()
        return True
    except Exception:
        return False


spark_required = pytest.mark.skipif(
    not _spark_reachable(),
    reason="Spark Connect server is not reachable — skipping Spark test",
)


# ─── API test client ───────────────────────────────────────────────────────────

@pytest.fixture
async def client():
    """Async httpx client wired to the FastAPI app with an isolated in-memory DB.

    * Each test gets a fresh SQLite database — no production data is touched.
    * ``init_db`` is mocked so the production metadata.db is never created/altered.
    * ``spark_service.drop_all_temp_views`` is mocked so Spark is not contacted
      during the FastAPI lifespan startup phase.
    * Routes that call Spark directly (``/data/query``, ``/data/catalog``, etc.)
      are not mocked here — tests for those endpoints must set up their own mock
      or use the ``spark_required`` mark.
    """
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        connect_args={"check_same_thread": False},
    )
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    session_factory = async_sessionmaker(
        engine, class_=AsyncSession, expire_on_commit=False
    )

    async def override_get_db():
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_db] = override_get_db

    with patch("app.main.init_db", new_callable=AsyncMock), \
         patch.object(spark_service, "drop_all_temp_views",
                      new_callable=AsyncMock, return_value=0):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://test",
        ) as ac:
            yield ac

    app.dependency_overrides.clear()
    await engine.dispose()
