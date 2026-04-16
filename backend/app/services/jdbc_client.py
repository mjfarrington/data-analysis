"""
JDBC Extract Client — reads a SQL file and extracts data in chunks.

Two operating modes
───────────────────
dummy=True   Generate synthetic rows without a real DB connection.
             Useful for pipeline testing before a JDBC source is available.

dummy=False  Connect via SQLAlchemy (any JDBC-compatible dialect) and
             stream rows with fetchmany() so memory usage stays bounded.

Quick CLI test
──────────────
# Dummy mode — no database required:
python -m app.services.jdbc_client \
    --sql-file data/sources/sql/active_transactions.sql \
    --dummy --rows 50000 --chunk-size 10000

# Real JDBC (SQLite sample DB bundled in the project):
python -m app.services.jdbc_client \
    --sql-file data/sources/sql/active_transactions.sql \
    --jdbc-url sqlite:///data/sources/sample.db
"""
from __future__ import annotations

import csv
import json
import logging
import random
import re
import sys
from datetime import date, timedelta
from itertools import islice
from pathlib import Path
from typing import Any, Iterator

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Dummy-data generators keyed on column-name patterns
# ---------------------------------------------------------------------------
_APPS = [f"APP{i:03d}" for i in range(1, 21)]
_STATUSES = ["active", "pending", "settled", "failed", "reversed"]
_CURRENCIES = ["GBP", "USD", "EUR", "JPY", "CHF", "AUD"]
_REGIONS = ["EMEA", "APAC", "AMER", "LATAM"]
_PRODUCTS = ["SWAP", "BOND", "FX", "EQUITY", "OPTION", "FUTURE"]
_BOOKS = ["BOOK_A", "BOOK_B", "BOOK_C", "BOOK_D"]

_DATE_START = date(2025, 1, 1)
_DATE_END = date(2026, 4, 14)


def _rand_date() -> str:
    delta = (_DATE_END - _DATE_START).days
    return (_DATE_START + timedelta(days=random.randint(0, delta))).isoformat()


def _rand_amount() -> float:
    return round(random.uniform(10.0, 999_999.0), 2)


# Maps (lowercase substring in column name) → value generator
_COLUMN_GENERATORS: list[tuple[str, Any]] = [
    ("transaction_id",  lambda: f"TXN{random.randint(1, 10_000_000):010d}"),
    ("application_id",  lambda: random.choice(_APPS)),
    ("counterparty_id", lambda: f"CP{random.randint(1, 500):04d}"),
    ("trader_id",       lambda: f"TDR{random.randint(1, 200):04d}"),
    ("_id",             lambda: random.randint(1, 1_000_000)),
    ("business_date",   _rand_date),
    ("value_date",      _rand_date),
    ("_date",           _rand_date),
    ("date",            _rand_date),
    ("amount",          _rand_amount),
    ("total_amount",    _rand_amount),
    ("avg_amount",      _rand_amount),
    ("max_amount",      _rand_amount),
    ("min_amount",      _rand_amount),
    ("trade_count",     lambda: random.randint(1, 500)),
    ("count",           lambda: random.randint(1, 500)),
    ("status",          lambda: random.choice(_STATUSES)),
    ("currency",        lambda: random.choice(_CURRENCIES)),
    ("region",          lambda: random.choice(_REGIONS)),
    ("product_code",    lambda: random.choice(_PRODUCTS)),
    ("book",            lambda: random.choice(_BOOKS)),
    ("source",          lambda: "dummy"),
    ("metric",          lambda: "N/A"),
]


def _make_generator(col: str):
    lower = col.lower()
    for pattern, gen in _COLUMN_GENERATORS:
        if pattern in lower:
            return gen
    # Fallback: short random string
    return lambda: f"val_{random.randint(0, 9999)}"


# ---------------------------------------------------------------------------
# SQL column parser
# ---------------------------------------------------------------------------

_SELECT_RE = re.compile(
    r"SELECT\s+(.*?)\s+FROM",
    re.IGNORECASE | re.DOTALL,
)
_ALIAS_RE = re.compile(r"(?:.*\s+AS\s+)?([\w]+)\s*$", re.IGNORECASE)


def _parse_columns(sql: str) -> list[str]:
    """
    Extract column (alias) names from a SELECT … FROM statement.
    Falls back to a generic set when parsing fails or SELECT * is used.
    """
    m = _SELECT_RE.search(sql)
    if not m:
        return ["id", "value", "status", "created_at"]

    raw = m.group(1).strip()
    if raw == "*":
        return [
            "transaction_id", "application_id", "business_date", "status",
            "amount", "currency", "region",
        ]

    cols: list[str] = []
    # Split on commas (not inside parentheses)
    depth = 0
    buf: list[str] = []
    for ch in raw:
        if ch == "(":
            depth += 1
            buf.append(ch)
        elif ch == ")":
            depth -= 1
            buf.append(ch)
        elif ch == "," and depth == 0:
            token = "".join(buf).strip()
            cols.append(token)
            buf = []
        else:
            buf.append(ch)
    if buf:
        cols.append("".join(buf).strip())

    names: list[str] = []
    for col_expr in cols:
        am = _ALIAS_RE.match(col_expr.strip())
        names.append(am.group(1) if am else col_expr.strip().split()[-1])
    return names or ["id", "value"]


# ---------------------------------------------------------------------------
# JdbcClient
# ---------------------------------------------------------------------------

class JdbcClient:
    """
    Chunked JDBC extract client.

    Parameters
    ----------
    jdbc_url:   SQLAlchemy connection string, e.g.
                  "sqlite:///data/sources/sample.db"
                  "postgresql+psycopg2://user:pass@host/db"
    dummy:      When True, generate synthetic rows instead of querying.
    chunk_size: Number of rows per chunk.
    total_dummy_rows:
                Total rows to generate in dummy mode.
    """

    def __init__(
        self,
        jdbc_url: str | None = None,
        dummy: bool = False,
        chunk_size: int = 10_000,
        total_dummy_rows: int = 100_000,
    ) -> None:
        self.jdbc_url = jdbc_url
        self.dummy = dummy
        self.chunk_size = chunk_size
        self.total_dummy_rows = total_dummy_rows

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def read_sql_file(self, sql_file: str | Path) -> str:
        path = Path(sql_file)
        if not path.exists():
            raise FileNotFoundError(f"SQL file not found: {path}")
        return path.read_text(encoding="utf-8").strip()

    def extract_chunks(self, sql: str) -> Iterator[list[dict]]:
        """
        Yield successive chunks of records for the given SQL query.
        Each chunk is a list of dicts (column → value).
        """
        if self.dummy:
            yield from self._dummy_chunks(sql)
        else:
            if not self.jdbc_url:
                raise ValueError("jdbc_url is required when dummy=False")
            yield from self._jdbc_chunks(sql)

    def save_chunk(
        self,
        records: list[dict],
        output_dir: str | Path,
        chunk_index: int,
        base_name: str = "extract",
        fmt: str = "parquet",
    ) -> Path:
        """
        Persist one chunk to disk. Returns the written file path.

        fmt: "parquet" (default, requires pandas/pyarrow) or "csv" / "jsonl"
        """
        out_dir = Path(output_dir)
        out_dir.mkdir(parents=True, exist_ok=True)

        if fmt == "parquet":
            return self._save_parquet(records, out_dir, base_name, chunk_index)
        if fmt == "csv":
            return self._save_csv(records, out_dir, base_name, chunk_index)
        if fmt == "jsonl":
            return self._save_jsonl(records, out_dir, base_name, chunk_index)
        raise ValueError(f"Unsupported output format: {fmt!r}")

    # ------------------------------------------------------------------
    # Dummy data generator
    # ------------------------------------------------------------------

    def _dummy_chunks(self, sql: str) -> Iterator[list[dict]]:
        cols = _parse_columns(sql)
        generators = [_make_generator(c) for c in cols]

        logger.info(
            "Dummy mode: generating %d rows with columns %s in chunks of %d",
            self.total_dummy_rows, cols, self.chunk_size,
        )

        remaining = self.total_dummy_rows
        while remaining > 0:
            n = min(self.chunk_size, remaining)
            chunk = [
                {col: gen() for col, gen in zip(cols, generators)}
                for _ in range(n)
            ]
            remaining -= n
            yield chunk

    # ------------------------------------------------------------------
    # Real JDBC reader (SQLAlchemy fetchmany streaming)
    # ------------------------------------------------------------------

    def _jdbc_chunks(self, sql: str) -> Iterator[list[dict]]:
        try:
            from sqlalchemy import create_engine, text
        except ImportError as exc:
            raise RuntimeError("sqlalchemy is required for JDBC mode") from exc

        engine = create_engine(self.jdbc_url, future=True)  # type: ignore[arg-type]
        logger.info("JDBC connect: %s", self.jdbc_url)

        try:
            with engine.connect() as conn:
                cursor = conn.execute(text(sql))
                cols = list(cursor.keys())
                logger.info(
                    "Query returned columns: %s — fetching in chunks of %d",
                    cols, self.chunk_size,
                )
                while True:
                    rows = cursor.fetchmany(self.chunk_size)
                    if not rows:
                        break
                    yield [dict(zip(cols, row)) for row in rows]
        finally:
            engine.dispose()

    # ------------------------------------------------------------------
    # Persistence helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _save_parquet(
        records: list[dict], out_dir: Path, base_name: str, chunk_index: int
    ) -> Path:
        try:
            import pandas as pd
        except ImportError as exc:
            raise RuntimeError("pandas is required for parquet output") from exc

        path = out_dir / f"{base_name}_{chunk_index:04d}.parquet"
        pd.DataFrame(records).to_parquet(path, index=False)
        return path

    @staticmethod
    def _save_csv(
        records: list[dict], out_dir: Path, base_name: str, chunk_index: int
    ) -> Path:
        path = out_dir / f"{base_name}_{chunk_index:04d}.csv"
        if not records:
            path.write_text("")
            return path
        with open(path, "w", newline="", encoding="utf-8") as fh:
            writer = csv.DictWriter(fh, fieldnames=list(records[0].keys()))
            writer.writeheader()
            writer.writerows(records)
        return path

    @staticmethod
    def _save_jsonl(
        records: list[dict], out_dir: Path, base_name: str, chunk_index: int
    ) -> Path:
        path = out_dir / f"{base_name}_{chunk_index:04d}.jsonl"
        with open(path, "w", encoding="utf-8") as fh:
            for rec in records:
                fh.write(json.dumps(rec, default=str) + "\n")
        return path


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def _cli() -> None:
    import argparse

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s  %(levelname)-7s  %(message)s",
        datefmt="%H:%M:%S",
    )

    parser = argparse.ArgumentParser(
        description="JDBC Extract Client — extract SQL query results in chunks."
    )
    parser.add_argument(
        "--sql-file",
        required=True,
        help="Path to a .sql file (relative to project root or absolute).",
    )
    parser.add_argument(
        "--jdbc-url",
        default=None,
        help=(
            "SQLAlchemy connection string. "
            "Defaults to the bundled SQLite sample DB when --dummy is not set."
        ),
    )
    parser.add_argument(
        "--dummy",
        action="store_true",
        help="Generate synthetic rows instead of querying a real database.",
    )
    parser.add_argument(
        "--rows",
        type=int,
        default=50_000,
        help="Total dummy rows to generate (dummy mode only). Default: 50000.",
    )
    parser.add_argument(
        "--chunk-size",
        type=int,
        default=10_000,
        help="Rows per output chunk/file. Default: 10000.",
    )
    parser.add_argument(
        "--output-dir",
        default=None,
        help="Directory to write chunk files. Defaults to data/pipeline/extracts/<sql_stem>/.",
    )
    parser.add_argument(
        "--format",
        choices=["parquet", "csv", "jsonl"],
        default="parquet",
        help="Output format for each chunk. Default: parquet.",
    )
    args = parser.parse_args()

    # Resolve paths relative to the project root (two levels above this file)
    project_root = Path(__file__).parents[3]
    sql_path = Path(args.sql_file)
    if not sql_path.is_absolute():
        sql_path = project_root / sql_path

    # Default JDBC URL: bundled SQLite sample DB
    jdbc_url = args.jdbc_url
    if not args.dummy and jdbc_url is None:
        jdbc_url = f"sqlite:///{project_root / 'data' / 'static' / 'sources' / 'sample.db'}"
        logger.info("No --jdbc-url provided; using sample SQLite DB: %s", jdbc_url)

    # Default output dir
    output_dir = Path(args.output_dir) if args.output_dir else (
        project_root / "data" / "pipeline" / "extracts" / sql_path.stem
    )

    client = JdbcClient(
        jdbc_url=jdbc_url,
        dummy=args.dummy,
        chunk_size=args.chunk_size,
        total_dummy_rows=args.rows,
    )

    sql = client.read_sql_file(sql_path)
    logger.info("SQL file: %s (%d chars)", sql_path.name, len(sql))

    total_rows = 0
    for chunk_idx, chunk in enumerate(client.extract_chunks(sql)):
        out_path = client.save_chunk(
            chunk,
            output_dir=output_dir,
            chunk_index=chunk_idx,
            base_name=sql_path.stem,
            fmt=args.format,
        )
        total_rows += len(chunk)
        logger.info(
            "  chunk %04d  %6d rows  →  %s",
            chunk_idx, len(chunk), out_path.relative_to(project_root),
        )

    logger.info(
        "Done. %d chunks, %d total rows → %s", chunk_idx + 1, total_rows, output_dir
    )


if __name__ == "__main__":
    _cli()
