#!/usr/bin/env python3
"""
Seed script — generates example test data and creates sample pipelines.

Run from the project root:
    python scripts/seed_data.py [--api http://localhost:8000]

What it creates
───────────────
data/sources/
  transactions.csv          500,000 rows of financial transactions
  events.jsonl              250,000 rows of application events (JSONL)
  sample.db                 SQLite DB with the same transactions table

data/sources/sql/
  active_transactions.sql   SELECT with date filter
  daily_summary.sql         aggregated daily totals
  event_counts.sql          event counts by type

Via API (pipelines + SQL files):
  3 ETL pipelines (gRPC, JDBC, CSV)
  3 SQL files in the database
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import random
import sqlite3
import sys
from datetime import date, timedelta
from pathlib import Path

# ── paths ──────────────────────────────────────────────────────────────────
SCRIPT_DIR = Path(__file__).parent
PROJECT_DIR = SCRIPT_DIR.parent
DATA_DIR = PROJECT_DIR / "data" / "sources"
DATA_DIR.mkdir(parents=True, exist_ok=True)
(DATA_DIR / "sql").mkdir(exist_ok=True)

random.seed(42)

# ── helpers ────────────────────────────────────────────────────────────────
APPS = [f"APP{str(i).zfill(3)}" for i in range(1, 21)]
STATUSES = ["active", "pending", "settled", "failed", "reversed"]
CCY = ["GBP", "USD", "EUR", "JPY", "CHF", "AUD"]
REGIONS = ["EMEA", "APAC", "AMER", "LATAM"]
EVENT_TYPES = ["login", "logout", "trade", "payment", "query", "alert", "batch_start", "batch_end"]
USERS = [f"user_{i:04d}" for i in range(1, 201)]

def random_date(start: date, end: date) -> str:
    delta = (end - start).days
    return (start + timedelta(days=random.randint(0, delta))).isoformat()

def random_amount() -> str:
    return f"{random.uniform(10.0, 999_999.0):.2f}"


# ── 1. transactions.csv ────────────────────────────────────────────────────
def generate_transactions_csv(n: int = 500_000) -> Path:
    path = DATA_DIR / "transactions.csv"
    if path.exists():
        print(f"  [skip] {path.name} already exists ({path.stat().st_size // 1024:,} KB)")
        return path

    print(f"  Generating {n:,} transaction rows → {path.name} ...")
    start_date = date(2025, 1, 1)
    end_date = date(2026, 4, 14)

    with open(path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow([
            "transaction_id", "application_id", "business_date", "status",
            "amount", "currency", "region", "counterparty_id", "product_code",
            "trader_id", "book", "value_date",
        ])
        for i in range(1, n + 1):
            bdate = random_date(start_date, end_date)
            writer.writerow([
                f"TXN{i:09d}",
                random.choice(APPS),
                bdate,
                random.choice(STATUSES),
                random_amount(),
                random.choice(CCY),
                random.choice(REGIONS),
                f"CTR{random.randint(1, 500):04d}",
                f"PROD{random.randint(1, 30):03d}",
                random.choice(USERS),
                f"BOOK{random.randint(1, 20):02d}",
                random_date(start_date, end_date),
            ])
            if i % 100_000 == 0:
                print(f"    ... {i:,} rows")

    size_mb = path.stat().st_size / 1_048_576
    print(f"  [ok] {path.name}: {n:,} rows, {size_mb:.1f} MB")
    return path


# ── 2. events.jsonl ────────────────────────────────────────────────────────
def generate_events_jsonl(n: int = 250_000) -> Path:
    path = DATA_DIR / "events.jsonl"
    if path.exists():
        print(f"  [skip] {path.name} already exists ({path.stat().st_size // 1024:,} KB)")
        return path

    print(f"  Generating {n:,} event rows → {path.name} ...")
    start_date = date(2025, 1, 1)
    end_date = date(2026, 4, 14)

    with open(path, "w", encoding="utf-8") as fh:
        for i in range(1, n + 1):
            bdate = random_date(start_date, end_date)
            record = {
                "event_id": f"EVT{i:010d}",
                "application_id": random.choice(APPS),
                "business_date": bdate,
                "event_type": random.choice(EVENT_TYPES),
                "user_id": random.choice(USERS),
                "region": random.choice(REGIONS),
                "latency_ms": round(random.expovariate(1 / 120), 1),
                "success": random.random() > 0.05,
                "session_id": f"sess_{random.randint(1, 50000):06d}",
                "metadata": {
                    "ip": f"10.{random.randint(0,255)}.{random.randint(0,255)}.{random.randint(1,254)}",
                    "service": f"svc_{random.randint(1, 8):02d}",
                },
            }
            fh.write(json.dumps(record) + "\n")
            if i % 50_000 == 0:
                print(f"    ... {i:,} rows")

    size_mb = path.stat().st_size / 1_048_576
    print(f"  [ok] {path.name}: {n:,} rows, {size_mb:.1f} MB")
    return path


# ── 3. sample.db (SQLite) ──────────────────────────────────────────────────
def generate_sqlite_db(n: int = 200_000) -> Path:
    path = DATA_DIR / "sample.db"
    if path.exists():
        print(f"  [skip] {path.name} already exists")
        return path

    print(f"  Generating SQLite DB with {n:,} rows → {path.name} ...")
    start_date = date(2025, 1, 1)
    end_date = date(2026, 4, 14)

    conn = sqlite3.connect(path)
    cur = conn.cursor()

    cur.execute("""
        CREATE TABLE transactions (
            transaction_id   TEXT PRIMARY KEY,
            application_id   TEXT NOT NULL,
            business_date    TEXT NOT NULL,
            status           TEXT NOT NULL,
            amount           REAL NOT NULL,
            currency         TEXT NOT NULL,
            region           TEXT NOT NULL,
            counterparty_id  TEXT,
            product_code     TEXT,
            trader_id        TEXT,
            book             TEXT,
            value_date       TEXT
        )
    """)
    cur.execute("CREATE INDEX idx_bdate ON transactions(business_date)")
    cur.execute("CREATE INDEX idx_app ON transactions(application_id)")

    batch: list = []
    for i in range(1, n + 1):
        bdate = random_date(start_date, end_date)
        batch.append((
            f"TXN{i:09d}",
            random.choice(APPS),
            bdate,
            random.choice(STATUSES),
            float(random_amount()),
            random.choice(CCY),
            random.choice(REGIONS),
            f"CTR{random.randint(1, 500):04d}",
            f"PROD{random.randint(1, 30):03d}",
            random.choice(USERS),
            f"BOOK{random.randint(1, 20):02d}",
            random_date(start_date, end_date),
        ))
        if len(batch) == 10_000:
            cur.executemany(
                "INSERT INTO transactions VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", batch
            )
            conn.commit()
            batch.clear()
            print(f"    ... {i:,} rows")

    if batch:
        cur.executemany(
            "INSERT INTO transactions VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", batch
        )
        conn.commit()

    conn.close()
    size_mb = path.stat().st_size / 1_048_576
    print(f"  [ok] {path.name}: {n:,} rows, {size_mb:.1f} MB")
    return path


# ── 4. SQL files on disk ───────────────────────────────────────────────────
SQL_FILES = {
    "active_transactions.sql": """\
-- Active transactions for a given business date
-- Used by the JDBC ETL pipeline (date filtered via jdbc_date_column)
SELECT
    transaction_id,
    application_id,
    business_date,
    status,
    amount,
    currency,
    region,
    counterparty_id,
    product_code,
    trader_id,
    book,
    value_date
FROM transactions
WHERE status IN ('active', 'pending')
ORDER BY application_id, business_date
""",
    "daily_summary.sql": """\
-- Daily summary of transaction volumes per application and currency
SELECT
    business_date,
    application_id,
    currency,
    status,
    COUNT(*)            AS trade_count,
    SUM(amount)         AS total_amount,
    AVG(amount)         AS avg_amount,
    MAX(amount)         AS max_amount,
    MIN(amount)         AS min_amount
FROM transactions
GROUP BY business_date, application_id, currency, status
ORDER BY business_date DESC, total_amount DESC
""",
    "event_counts.sql": """\
-- Placeholder: event counts by type (adapt to your events table)
SELECT
    'events' AS source,
    'N/A'    AS metric
""",
}

def write_sql_files() -> None:
    for name, content in SQL_FILES.items():
        path = DATA_DIR / "sql" / name
        if not path.exists():
            path.write_text(content, encoding="utf-8")
            print(f"  [ok] {path.name}")
        else:
            print(f"  [skip] {path.name}")


# ── 5. API seeding ─────────────────────────────────────────────────────────
def seed_api(api_base: str) -> None:
    try:
        import urllib.request
        import urllib.error
    except ImportError:
        print("  [skip] urllib not available")
        return

    def post(path: str, data: dict) -> dict | None:
        url = f"{api_base}/api/v1{path}"
        body = json.dumps(data).encode()
        req = urllib.request.Request(
            url, data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            if e.code == 409 or e.code == 422:
                return None  # already exists, skip
            body_txt = e.read().decode()
            print(f"  [warn] POST {path} → HTTP {e.code}: {body_txt[:120]}")
            return None
        except Exception as ex:
            print(f"  [warn] POST {path} → {ex}")
            return None

    # ── SQL files ────────────────────────────────────────────────────────
    print("\n  Creating SQL files in database...")
    sql_file_ids: dict[str, int] = {}
    api_sql_files = [
        {
            "name": "active_transactions",
            "description": "Active & pending transactions filtered by business date",
            "content": SQL_FILES["active_transactions.sql"],
        },
        {
            "name": "daily_summary",
            "description": "Daily aggregated totals by app, currency, and status",
            "content": SQL_FILES["daily_summary.sql"],
        },
    ]
    for sf in api_sql_files:
        result = post("/etl/sql-files", sf)
        if result and "id" in result:
            sql_file_ids[sf["name"]] = result["id"]
            print(f"    [ok] SQL file '{sf['name']}' → id={result['id']}")
        else:
            print(f"    [skip] SQL file '{sf['name']}' (may already exist)")

    # ── Pipelines ────────────────────────────────────────────────────────
    print("\n  Creating sample pipelines...")
    today = date.today().isoformat()
    week_ago = (date.today() - timedelta(days=7)).isoformat()

    pipelines = [
        {
            "name": "gRPC Daily Extract — All Apps",
            "description": "Extracts all application data from the gRPC dummy service for a date range",
            "extract_config": {
                "source_type": "grpc",
                "application_ids": ["APP001", "APP002", "APP003", "APP004", "APP005"],
                "date_from": week_ago,
                "date_to": today,
                "rows_per_segment": 10000,
                "page_size": 10000,
                "output_format": "parquet",
            },
            "transform_config": {
                "filters": {},
                "drop_columns": [],
                "rename_columns": {},
                "dedup": True,
                "dedup_keys": ["id"],
            },
            "load_config": {
                "target": "parquet",
                "partition_by": ["date", "application_id"],
                "mode": "overwrite",
            },
            "schedule": "0 2 * * *",
            "schedule_enabled": False,
        },
        {
            "name": "JDBC Transactions — Active Only",
            "description": "Extracts active & pending transactions from SQLite sample DB, segmented at 50k rows/file",
            "extract_config": {
                "source_type": "jdbc",
                "application_ids": ["default"],
                "date_from": week_ago,
                "date_to": today,
                "rows_per_segment": 50000,
                "page_size": 10000,
                "output_format": "parquet",
                "jdbc_url": f"sqlite:///{DATA_DIR}/sample.db",
                "jdbc_sql_file_id": sql_file_ids.get("active_transactions"),
                "jdbc_date_column": "business_date",
            },
            "transform_config": {
                "filters": {},
                "drop_columns": ["value_date"],
                "rename_columns": {"counterparty_id": "cpty_id"},
                "dedup": True,
                "dedup_keys": ["transaction_id"],
            },
            "load_config": {
                "target": "parquet",
                "partition_by": ["business_date"],
                "mode": "overwrite",
            },
            "schedule": "0 3 * * 1-5",
            "schedule_enabled": False,
        },
        {
            "name": "CSV Events — Full Load",
            "description": "Loads all events from the JSONL file and splits into 25k-row segments",
            "extract_config": {
                "source_type": "json",
                "application_ids": ["default"],
                "dates": [today],
                "rows_per_segment": 25000,
                "page_size": 10000,
                "output_format": "parquet",
                "file_path": "events.jsonl",
                "json_lines": True,
            },
            "transform_config": {
                "filters": {},
                "drop_columns": ["metadata"],
                "rename_columns": {},
                "dedup": True,
                "dedup_keys": ["event_id"],
            },
            "load_config": {
                "target": "parquet",
                "partition_by": ["business_date"],
                "mode": "overwrite",
            },
            "schedule": "30 1 * * *",
            "schedule_enabled": False,
        },
        {
            "name": "CSV Transactions — Daily Snapshot",
            "description": "Loads transaction CSV, 100k rows per segment output file",
            "extract_config": {
                "source_type": "csv",
                "application_ids": ["default"],
                "dates": [today],
                "rows_per_segment": 100000,
                "page_size": 10000,
                "output_format": "csv",
                "file_path": "transactions.csv",
                "csv_delimiter": ",",
                "csv_has_header": True,
            },
            "transform_config": {
                "filters": {"status": "active"},
                "drop_columns": [],
                "rename_columns": {},
                "dedup": True,
                "dedup_keys": ["transaction_id"],
            },
            "load_config": {
                "target": "csv",
                "partition_by": ["business_date"],
                "mode": "overwrite",
            },
            "schedule": "",
            "schedule_enabled": False,
        },
    ]

    for pl in pipelines:
        result = post("/etl/pipelines", pl)
        if result and "id" in result:
            print(f"    [ok] Pipeline '{pl['name']}' → id={result['id']}")
        else:
            print(f"    [skip] Pipeline '{pl['name']}' (may already exist)")


# ── main ───────────────────────────────────────────────────────────────────
def main() -> None:
    parser = argparse.ArgumentParser(description="Seed test data for the Data Analysis Platform")
    parser.add_argument("--api", default="http://localhost:8000", help="API base URL")
    parser.add_argument("--no-files", action="store_true", help="Skip large file generation")
    parser.add_argument("--no-api", action="store_true", help="Skip API seeding")
    args = parser.parse_args()

    print("━" * 60)
    print(" Data Analysis Platform — Test Data Seeder")
    print("━" * 60)

    if not args.no_files:
        print("\n[1/3] Generating source data files...")
        write_sql_files()
        generate_transactions_csv(500_000)
        generate_events_jsonl(250_000)
        generate_sqlite_db(200_000)
    else:
        print("\n[1/3] Skipping file generation (--no-files)")

    if not args.no_api:
        print(f"\n[2/3] Seeding via API at {args.api} ...")
        seed_api(args.api)
    else:
        print("\n[2/3] Skipping API seeding (--no-api)")

    print("\n[3/3] Done!")
    print("\n  Source files:   data/sources/")
    print("  SQL files:      data/sources/sql/")
    print("  Run pipeline:   http://localhost:3000 → ETL Pipelines")
    print("━" * 60)


if __name__ == "__main__":
    main()
