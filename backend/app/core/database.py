from __future__ import annotations
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase
from sqlalchemy import event, inspect, text
from app.core.config import settings

engine = create_async_engine(
    settings.DATABASE_URL,
    echo=settings.DEBUG,
    connect_args={"check_same_thread": False},
)

# Enable SQLite foreign key enforcement (off by default in SQLite)
@event.listens_for(engine.sync_engine, "connect")
def _set_sqlite_pragma(dbapi_connection, connection_record):
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()

AsyncSessionLocal = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


class Base(DeclarativeBase):
    pass


def _ensure_pipeline_category_column(sync_conn) -> None:
    inspector = inspect(sync_conn)
    if "etl_pipelines" not in inspector.get_table_names():
        return
    columns = {column["name"] for column in inspector.get_columns("etl_pipelines")}
    if "category" in columns:
        return

    sync_conn.execute(
        text("ALTER TABLE etl_pipelines ADD COLUMN category VARCHAR(100) NOT NULL DEFAULT 'Unknown'")
    )
    sync_conn.execute(
        text("UPDATE etl_pipelines SET category = 'Unknown' WHERE category IS NULL OR category = ''")
    )


async def get_db() -> AsyncSession:
    async with AsyncSessionLocal() as session:
        try:
            yield session
        finally:
            await session.close()


async def init_db() -> None:
    from app.models import etl  # noqa: F401 — registers models
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.run_sync(_ensure_pipeline_category_column)
