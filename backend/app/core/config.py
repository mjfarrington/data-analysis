from __future__ import annotations
import os
from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # App
    APP_NAME: str = "Data Analysis Platform"
    APP_VERSION: str = "1.0.0"
    DEBUG: bool = False
    LOG_LEVEL: str = "INFO"

    # API
    API_PREFIX: str = "/api/v1"
    CORS_ORIGINS: list[str] = [
        "http://localhost:3000",
        "http://localhost:5173",
        "http://127.0.0.1:3000",
    ]

    # Database (SQLite for metadata)
    DATABASE_URL: str = f"sqlite+aiosqlite:///{Path(__file__).parents[3] / 'data' / 'metadata.db'}"

    # Spark
    SPARK_MASTER_URL: str = "spark://localhost:7077"
    SPARK_CONNECT_URL: str = "sc://localhost:15002"
    SPARK_THRIFT_HOST: str = "localhost"
    SPARK_THRIFT_PORT: int = 10000
    SPARK_MASTER_WEBUI: str = "http://localhost:8080"
    SPARK_WORKER_WEBUI: str = "http://localhost:8081"
    SPARK_HISTORY_WEBUI: str = "http://localhost:18080"
    SPARK_HOME: str = str(Path(__file__).parents[3] / "tools" / "spark")

    # Data storage
    DATA_DIR:           str = str(Path(__file__).parents[3] / "data")
    STATIC_DIR:         str = str(Path(__file__).parents[3] / "data" / "static")
    PIPELINE_DIR:       str = str(Path(__file__).parents[3] / "data" / "pipeline")
    EXTRACT_DIR:        str = str(Path(__file__).parents[3] / "data" / "pipeline" / "extracts")
    PARQUET_DIR:        str = str(Path(__file__).parents[3] / "data" / "pipeline" / "parquet")
    SOURCES_DIR:        str = str(Path(__file__).parents[3] / "data" / "static" / "sources")
    SQL_EXTRACT_DIR:    str = str(Path(__file__).parents[3] / "data" / "static" / "sql" / "extract")
    SQL_TRANSFORM_DIR:  str = str(Path(__file__).parents[3] / "data" / "static" / "sql" / "transform")
    SPARK_EVENTS_DIR:   str = str(Path(__file__).parents[3] / "data" / "spark" / "events")
    SPARK_WAREHOUSE_DIR: str = str(Path(__file__).parents[3] / "data" / "spark" / "warehouse")

    # ETL defaults
    DEFAULT_PAGE_SIZE: int = 10_000
    MAX_CONCURRENT_RUNS: int = 5

    # Connections — secret key for Fernet encryption of stored passwords.
    # Generate with: python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
    # Must be set in .env — do NOT commit the actual key.
    CONNECTIONS_SECRET_KEY: str = ''

    @property
    def data_path(self) -> Path:
        return Path(self.DATA_DIR)

    @property
    def extract_path(self) -> Path:
        return Path(self.EXTRACT_DIR)

    @property
    def parquet_path(self) -> Path:
        return Path(self.PARQUET_DIR)


settings = Settings()

# Ensure data directories exist
for _dir in [
    settings.DATA_DIR, settings.STATIC_DIR, settings.PIPELINE_DIR,
    settings.EXTRACT_DIR, settings.PARQUET_DIR, settings.SOURCES_DIR,
    settings.SQL_EXTRACT_DIR, settings.SQL_TRANSFORM_DIR,
    settings.SPARK_EVENTS_DIR, settings.SPARK_WAREHOUSE_DIR,
]:
    Path(_dir).mkdir(parents=True, exist_ok=True)
