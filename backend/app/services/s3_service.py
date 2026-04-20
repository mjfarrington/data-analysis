"""
S3 / S3-compatible extract service.
====================================
Reads files from S3 (or any S3-compatible store like MinIO), applies an
optional SQL transformation via a Spark temp view, then saves the result
to the Spark catalogue.

File discovery uses a two-level approach:
  1. List all objects under ``prefix`` using boto3.
  2. Filter keys client-side using a Unix-shell glob pattern (fnmatch).

This supports patterns like:
  - ``data/trades/2026-04-*/*.parquet``   — date-prefixed partitions
  - ``feeds/*/input.csv``                  — wildcard mid-path
  - ``reports/**``                         — entire sub-tree (fnmatch: ``**`` = any)

Progress events  (SSE-friendly dicts)
--------------------------------------
  { "event": "listing",   "message": "..." }
  { "event": "matched",   "count": N, "files": [...first 10...] }
  { "event": "download",  "file": "key", "index": N, "total": N }
  { "event": "reading",   "message": "...", "file_count": N }
  { "event": "transform", "message": "..." }
  { "event": "saving",    "target": "db.table", "mode": "..." }
  { "event": "done",      "rows": N, "duration_s": F, "target": "db.table" }
  { "event": "error",     "message": "...", "detail": "..." }
"""
from __future__ import annotations

import fnmatch
import logging
import os
import shutil
import tempfile
import time
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Generator, Iterator, Optional

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Config
# ─────────────────────────────────────────────────────────────────────────────

class S3Format(str, Enum):
    AUTO    = "auto"
    PARQUET = "parquet"
    CSV     = "csv"
    JSON    = "json"
    ORC     = "orc"

    @classmethod
    def detect(cls, key: str) -> "S3Format":
        key_lower = key.lower()
        if key_lower.endswith(".parquet") or key_lower.endswith(".snappy.parquet"):
            return cls.PARQUET
        if key_lower.endswith(".csv") or key_lower.endswith(".csv.gz"):
            return cls.CSV
        if key_lower.endswith(".json") or key_lower.endswith(".jsonl"):
            return cls.JSON
        if key_lower.endswith(".orc"):
            return cls.ORC
        return cls.AUTO


class WriteMode(str, Enum):
    OVERWRITE = "overwrite"
    APPEND    = "append"
    IGNORE    = "ignore"
    ERROR     = "error"


@dataclass
class S3ConnectionConfig:
    """All settings needed to open an S3 connection."""
    bucket:       str
    region:       str                 = "us-east-1"
    access_key:   str                 = ""          # maps to Connection.username
    secret_key:   str                 = ""          # maps to Connection.password (encrypted)
    endpoint_url: Optional[str]       = None        # S3-compatible override (MinIO, etc.)
    extra:        dict[str, Any]      = field(default_factory=dict)

    @property
    def boto_client(self):
        """Build and return a boto3 S3 client."""
        import boto3  # type: ignore
        kwargs: dict[str, Any] = {
            "region_name": self.region,
        }
        if self.access_key:
            kwargs["aws_access_key_id"]     = self.access_key
            kwargs["aws_secret_access_key"] = self.secret_key
        if self.endpoint_url:
            kwargs["endpoint_url"] = self.endpoint_url
        return boto3.client("s3", **kwargs)


# ─────────────────────────────────────────────────────────────────────────────
# Config builder from ORM model
# ─────────────────────────────────────────────────────────────────────────────

def config_from_connection(conn, plain_secret: str | None = None) -> S3ConnectionConfig:
    """Build an S3ConnectionConfig from a saved Connection ORM model."""
    from app.services.crypto import decrypt_password

    extra = conn.extra or {}
    secret = plain_secret
    if not secret and conn.password_encrypted:
        secret = decrypt_password(conn.password_encrypted)

    return S3ConnectionConfig(
        bucket       = str(extra.get("bucket", "")),
        region       = str(extra.get("region", "us-east-1")),
        access_key   = conn.username or "",
        secret_key   = secret or "",
        endpoint_url = extra.get("endpoint_url") or None,
        extra        = {k: v for k, v in extra.items() if k not in ("bucket", "region", "endpoint_url")},
    )


# ─────────────────────────────────────────────────────────────────────────────
# File listing
# ─────────────────────────────────────────────────────────────────────────────

def list_matching_files(
    config:   S3ConnectionConfig,
    prefix:   str,
    pattern:  str = "*",
    max_keys: int = 10_000,
) -> list[str]:
    """
    List S3 object keys under *prefix* that match *pattern* (fnmatch glob).

    The pattern is matched against the key relative to *prefix*, so you can
    write patterns like ``2026-04-*/*.parquet`` without repeating the prefix.

    Returns a list of full S3 keys (e.g. ``data/2026-04-16/part-00.parquet``).
    """
    s3     = config.boto_client
    prefix = prefix.rstrip("/") + "/" if prefix else ""

    paginator = s3.get_paginator("list_objects_v2")
    keys: list[str] = []

    for page in paginator.paginate(
        Bucket   = config.bucket,
        Prefix   = prefix,
        PaginationConfig={"MaxItems": max_keys},
    ):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            # Skip "directory" markers
            if key.endswith("/"):
                continue
            # Match against the portion after the prefix
            relative = key[len(prefix):]
            if fnmatch.fnmatch(relative, pattern) or fnmatch.fnmatch(key, pattern):
                keys.append(key)

    return sorted(keys)


def test_connection_sync(config: S3ConnectionConfig) -> dict:
    """Quick connectivity test — list up to 1 key in the bucket."""
    import time
    t0 = time.perf_counter()
    try:
        s3 = config.boto_client
        resp = s3.list_objects_v2(Bucket=config.bucket, MaxKeys=1)
        count = resp.get("KeyCount", 0)
        total = resp.get("Contents", [])
        latency = round((time.perf_counter() - t0) * 1000, 1)
        return {
            "ok": True,
            "latency_ms": latency,
            "message": f"Connected to s3://{config.bucket} — {count} object(s) visible",
        }
    except Exception as exc:
        latency = round((time.perf_counter() - t0) * 1000, 1)
        return {
            "ok": False,
            "latency_ms": latency,
            "message": str(exc),
        }


# ─────────────────────────────────────────────────────────────────────────────
# Core ingest logic (sync generator — runs in a thread pool)
# ─────────────────────────────────────────────────────────────────────────────

def ingest_sync(
    config:        S3ConnectionConfig,
    prefix:        str,
    pattern:       str,
    fmt:           S3Format,
    transform_sql: Optional[str],
    target_db:     str,
    target_table:  str,
    write_mode:    WriteMode = WriteMode.OVERWRITE,
    # CSV reader options
    csv_header:    bool      = True,
    csv_sep:       str       = ",",
    csv_infer:     bool      = True,
    # Spark read options (passed through)
    reader_options: dict[str, str] | None = None,
) -> Generator[dict, None, None]:
    """
    Download matching S3 files to a temp dir, read into Spark,
    apply an optional SQL transform, then save to the Spark catalogue.

    Yields progress event dicts throughout.
    """
    from app.services.spark_service import _get_spark, _ensure_namespace_db  # type: ignore

    t_start = time.perf_counter()
    tmp_dir: Optional[str] = None

    try:
        # ── 1. List matching files ────────────────────────────────────────────
        yield {"event": "listing", "message": f"Listing s3://{config.bucket}/{prefix} with pattern '{pattern}'"}

        keys = list_matching_files(config, prefix, pattern)
        if not keys:
            yield {
                "event": "error",
                "message": f"No files matched pattern '{pattern}' under s3://{config.bucket}/{prefix}",
                "detail": "",
            }
            return

        yield {
            "event": "matched",
            "count": len(keys),
            "files": keys[:10],  # first 10 for preview
        }

        # ── 2. Download to temp directory ─────────────────────────────────────
        tmp_dir = tempfile.mkdtemp(prefix="s3_ingest_")
        s3 = config.boto_client

        # Auto-detect format from the first file if not specified
        effective_fmt = fmt
        if effective_fmt == S3Format.AUTO:
            effective_fmt = S3Format.detect(keys[0])

        # Mirror S3 key structure locally so Spark can use directory-level reads
        local_paths: list[str] = []
        for idx, key in enumerate(keys, 1):
            relative = key.lstrip("/")
            local_path = Path(tmp_dir) / relative
            local_path.parent.mkdir(parents=True, exist_ok=True)
            yield {"event": "download", "file": key, "index": idx, "total": len(keys)}
            s3.download_file(config.bucket, key, str(local_path))
            local_paths.append(str(local_path))

        # ── 3. Read into Spark ───────────────────────────────────────────────
        yield {"event": "reading", "message": f"Reading {len(local_paths)} file(s) as {effective_fmt.value} into Spark", "file_count": len(local_paths)}

        spark = _get_spark()
        reader = spark.read

        ropts = reader_options or {}
        if effective_fmt == S3Format.PARQUET:
            df = reader.options(**ropts).parquet(tmp_dir)
        elif effective_fmt == S3Format.CSV:
            df = reader.options(
                header=str(csv_header).lower(),
                sep=csv_sep,
                inferSchema=str(csv_infer).lower(),
                **ropts,
            ).csv(tmp_dir)
        elif effective_fmt == S3Format.JSON:
            df = reader.options(**ropts).json(tmp_dir)
        elif effective_fmt == S3Format.ORC:
            df = reader.options(**ropts).orc(tmp_dir)
        else:
            # Last resort: try parquet
            df = reader.options(**ropts).parquet(tmp_dir)

        schema_cols = [f"{c.name}:{c.dataType.simpleString()}" for c in df.schema]
        yield {
            "event": "schema",
            "columns": schema_cols,
            "column_count": len(schema_cols),
        }

        # ── 4. Apply SQL transformation ───────────────────────────────────────
        if transform_sql and transform_sql.strip():
            view_name = f"_s3_ingest_{target_table}"
            df.createOrReplaceTempView(view_name)
            yield {"event": "transform", "message": f"Applying SQL transform (temp view: {view_name})"}
            df = spark.sql(transform_sql.replace("{source}", view_name))

        # ── 5. Save to Spark catalogue ────────────────────────────────────────
        full_table = f"`{target_db}`.`{target_table}`"
        yield {"event": "saving", "target": full_table, "mode": write_mode.value}

        _ensure_namespace_db(spark, target_db)
        df.write.mode(write_mode.value).format("parquet").saveAsTable(full_table)

        row_count = spark.table(full_table).count()
        duration = round(time.perf_counter() - t_start, 2)

        yield {
            "event": "done",
            "rows":     row_count,
            "duration_s": duration,
            "target":   full_table,
            "files_ingested": len(local_paths),
        }

    except Exception as exc:
        logger.exception("S3 ingest failed")
        yield {"event": "error", "message": str(exc), "detail": repr(exc)}

    finally:
        if tmp_dir and Path(tmp_dir).exists():
            shutil.rmtree(tmp_dir, ignore_errors=True)


# ─────────────────────────────────────────────────────────────────────────────
# Async streaming wrapper
# ─────────────────────────────────────────────────────────────────────────────

async def ingest_stream_async(
    config:        S3ConnectionConfig,
    prefix:        str,
    pattern:       str,
    fmt:           S3Format,
    transform_sql: Optional[str],
    target_db:     str,
    target_table:  str,
    write_mode:    WriteMode = WriteMode.OVERWRITE,
    csv_header:    bool      = True,
    csv_sep:       str       = ",",
    csv_infer:     bool      = True,
    reader_options: dict[str, str] | None = None,
):
    """
    Async generator yielding SSE-formatted ``data: {...}\\n\\n`` strings.
    Drives *ingest_sync* in a background thread.
    """
    import asyncio
    import json
    import queue
    import threading

    q: queue.Queue[dict | None] = queue.Queue()

    def _run():
        try:
            for ev in ingest_sync(
                config, prefix, pattern, fmt,
                transform_sql, target_db, target_table,
                write_mode, csv_header, csv_sep, csv_infer, reader_options,
            ):
                q.put(ev)
        except Exception as exc:
            q.put({"event": "error", "message": str(exc), "detail": repr(exc)})
        finally:
            q.put(None)

    thread = threading.Thread(target=_run, daemon=True)
    thread.start()
    loop = asyncio.get_event_loop()

    while True:
        ev = await loop.run_in_executor(None, q.get)
        if ev is None:
            break
        yield f"data: {json.dumps(ev)}\n\n"
        if ev.get("event") in ("done", "error"):
            break


# ─────────────────────────────────────────────────────────────────────────────
# Async wrappers
# ─────────────────────────────────────────────────────────────────────────────

async def test_connection(config: S3ConnectionConfig) -> dict:
    import asyncio
    return await asyncio.to_thread(test_connection_sync, config)


async def list_files(
    config:   S3ConnectionConfig,
    prefix:   str,
    pattern:  str = "*",
    max_keys: int = 1000,
) -> list[str]:
    import asyncio
    return await asyncio.to_thread(list_matching_files, config, prefix, pattern, max_keys)
