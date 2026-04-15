# Data Analysis Platform

A full-stack data analysis platform with ETL pipeline management, Spark-powered storage, and real-time monitoring.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  React + Material UI (Vite)           :3000                     │
│  Dashboard · ETL Pipelines · Runs · Data Explorer · Errors      │
└────────────────────┬────────────────────────────────────────────┘
                     │ HTTP / WebSocket
┌────────────────────▼────────────────────────────────────────────┐
│  FastAPI Backend                      :8000                     │
│  ETL Engine · Spark Service · gRPC Client                       │
│  SQLite metadata · WebSocket log streaming                      │
└──────┬──────────────────────────┬──────────────────────────────┘
       │ Spark Connect (gRPC)      │ gRPC
┌──────▼──────────┐  ┌────────────▼───────────┐
│  Spark Cluster  │  │  Data Extract Service  │
│  Master  :7077  │  │  (Dummy) :50051        │
│  Worker  :8081  │  │  Returns mock records  │
│  Thrift  :10000 │  │  by app_id + date +    │
│  Connect :15002 │  │  segment               │
│  History :18080 │  └────────────────────────┘
└─────────────────┘
```

## Quick Start

### 1. Prerequisites

- Python 3.11+
- Node.js 18+
- Java 11+ (for Spark)

### 2. Install dependencies

```bash
./scripts/setup.sh
```

### 3. Start Spark cluster

```bash
./scripts/spark-manager.sh start
```

### 4. Start all services

```bash
./scripts/dev.sh
```

### 5. Open the app

- **Frontend**: http://localhost:3000
- **API docs**: http://localhost:8000/docs
- **Spark Master UI**: http://localhost:8080
- **Spark History**: http://localhost:18080

### Stop everything

```bash
./scripts/stop.sh
```

---

## Spark Manager

```bash
# Start all services (master, worker, thriftserver, connect, history)
./scripts/spark-manager.sh start

# Start individual services
./scripts/spark-manager.sh start master
./scripts/spark-manager.sh start worker
./scripts/spark-manager.sh start thrift
./scripts/spark-manager.sh start connect
./scripts/spark-manager.sh start history

# Status
./scripts/spark-manager.sh status

# Test connections
./scripts/spark-manager.sh test

# View logs
./scripts/spark-manager.sh logs master
./scripts/spark-manager.sh logs thrift 200

# Stop
./scripts/spark-manager.sh stop
```

---

## Project Structure

```
data-analysis/
├── scripts/
│   ├── spark-manager.sh    # Start/stop/status Spark cluster
│   ├── setup.sh            # Install all dependencies
│   ├── dev.sh              # Launch all services
│   └── stop.sh             # Stop all services
├── grpc/
│   ├── proto/              # Protocol Buffer definitions
│   │   └── data_extract.proto
│   ├── generated/          # Auto-generated stubs (run setup.sh)
│   ├── server.py           # Dummy gRPC server
│   └── generate_protos.sh  # Regenerate stubs
├── backend/
│   ├── app/
│   │   ├── main.py         # FastAPI app + WebSocket
│   │   ├── core/           # Config, database
│   │   ├── models/         # SQLAlchemy models
│   │   ├── schemas/        # Pydantic schemas
│   │   ├── api/routes/     # REST endpoints
│   │   └── services/       # Spark, gRPC, ETL engine
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── pages/          # Dashboard, ETL, Runs, Explorer, Errors
│   │   ├── components/     # Layout, StatusChip, etc.
│   │   ├── api/            # API client + TypeScript types
│   │   ├── hooks/          # useWebSocket
│   │   └── theme/          # MUI dark/light themes
│   └── package.json
├── data/
│   ├── extracts/           # Raw extracted data
│   ├── parquet/            # Persisted parquet files (app_id/date/segment)
│   └── spark-events/       # Spark event logs
└── logs/
    ├── spark/              # Spark service logs
    ├── backend/            # FastAPI logs
    └── grpc/               # gRPC server logs
```

---

## Data Storage Layout

Parquet files are partitioned by `application_id` and `date`:

```
data/parquet/
└── APP001/
    └── 2025-01-15/
        ├── segment_0000.parquet
        ├── segment_0001.parquet
        └── segment_0002.parquet
```

Each segment file can hold millions of records. Spark reads them efficiently via predicate pushdown.

---

## ETL Pipeline Configuration

### Extract Config
- `application_ids`: List of app IDs to extract (e.g. `["APP001", "APP002"]`)
- `date_from` / `date_to`: Date range for extraction
- `page_size`: Records per segment/chunk (default: 10,000)
- `output_format`: `parquet` or `csv`

### Transform Config
- `filters`: Column equality filters `{"status": "ACTIVE"}`
- `drop_columns`: Columns to remove
- `dedup`: Enable deduplication (on `dedup_keys`)

### Load Config
- `target`: `parquet`, `csv`, or `spark_table`
- `mode`: `overwrite` or `append`

---

## gRPC Data Extract Service

The dummy service simulates extracting data from a bespoke API:

- **20 application IDs** (APP001–APP020)
- **Date range**: 2024-01-01 to 2025-12-31
- **3–8 segments** per app+date combination
- **Deterministic data**: same request = same response
- **~10,000 records per segment** (configurable)

Replace `grpc/server.py` with your real gRPC service when ready. The proto contract is defined in `grpc/proto/data_extract.proto`.
