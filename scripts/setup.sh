#!/usr/bin/env bash
# =============================================================================
# Setup Script — installs all dependencies for the data-analysis platform
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

GREEN='\033[0;32m'; BLUE='\033[0;34m'; YELLOW='\033[1;33m'; NC='\033[0m'; BOLD='\033[1m'
log() { echo -e "${BLUE}[setup]${NC} $*"; }
ok()  { echo -e "${GREEN}[done]${NC}  $*"; }
warn(){ echo -e "${YELLOW}[warn]${NC}  $*"; }

# ─────────────────────────────────────────────────────────────────────────────
log "Checking Python 3.11+"
if ! command -v python3 &>/dev/null; then
    echo "Python 3 is required. Install via homebrew: brew install python@3.11"
    exit 1
fi
PYTHON_VERSION=$(python3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
log "  Found Python $PYTHON_VERSION"

# ─────────────────────────────────────────────────────────────────────────────
log "Setting up Python virtual environments"

# Backend venv
if [[ ! -d "$PROJECT_DIR/backend/.venv" ]]; then
    log "  Creating backend venv..."
    python3 -m venv "$PROJECT_DIR/backend/.venv"
fi
log "  Installing backend dependencies..."
"$PROJECT_DIR/backend/.venv/bin/pip" install -q --upgrade pip
"$PROJECT_DIR/backend/.venv/bin/pip" install -q -r "$PROJECT_DIR/backend/requirements.txt"
ok "Backend dependencies installed"

# gRPC venv (shares with backend or separate)
if [[ ! -d "$PROJECT_DIR/grpc/.venv" ]]; then
    log "  Creating gRPC venv..."
    python3 -m venv "$PROJECT_DIR/grpc/.venv"
fi
log "  Installing gRPC dependencies..."
"$PROJECT_DIR/grpc/.venv/bin/pip" install -q --upgrade pip
"$PROJECT_DIR/grpc/.venv/bin/pip" install -q -r "$PROJECT_DIR/grpc/requirements.txt"
ok "gRPC dependencies installed"

# ─────────────────────────────────────────────────────────────────────────────
log "Generating gRPC protobuf stubs"
chmod +x "$PROJECT_DIR/grpc/generate_protos.sh"
(cd "$PROJECT_DIR/grpc" && .venv/bin/python -m grpc_tools.protoc \
    -I proto \
    --python_out=generated \
    --grpc_python_out=generated \
    proto/data_extract.proto)
# Fix import
sed -i '' 's/^import data_extract_pb2/from . import data_extract_pb2/' \
    "$PROJECT_DIR/grpc/generated/data_extract_pb2_grpc.py" 2>/dev/null || \
sed -i 's/^import data_extract_pb2/from . import data_extract_pb2/' \
    "$PROJECT_DIR/grpc/generated/data_extract_pb2_grpc.py"
ok "gRPC stubs generated"

# ─────────────────────────────────────────────────────────────────────────────
log "Checking Node.js / npm for frontend"
if ! command -v node &>/dev/null; then
    warn "Node.js not found. Install it: brew install node"
    warn "Skipping frontend dependency installation."
else
    NODE_VERSION=$(node --version)
    log "  Found Node.js $NODE_VERSION"
    log "  Installing frontend dependencies..."
    (cd "$PROJECT_DIR/frontend" && npm install --prefer-offline 2>&1 | tail -3)
    ok "Frontend dependencies installed"
fi

# ─────────────────────────────────────────────────────────────────────────────
log "Creating data directories"
mkdir -p "$PROJECT_DIR/data"/{extracts,parquet,csv,spark-events,spark-warehouse}
mkdir -p "$PROJECT_DIR/logs"/{spark/pid,backend,grpc}
ok "Directories created"

# ─────────────────────────────────────────────────────────────────────────────
log "Creating .env if not exists"
if [[ ! -f "$PROJECT_DIR/backend/.env" ]]; then
    cp "$PROJECT_DIR/backend/.env.example" "$PROJECT_DIR/backend/.env" 2>/dev/null || cat > "$PROJECT_DIR/backend/.env" <<'ENVEOF'
APP_NAME=Data Analysis Platform
DEBUG=false
LOG_LEVEL=INFO

# Spark
SPARK_MASTER_URL=spark://localhost:7077
SPARK_CONNECT_URL=sc://localhost:15002
SPARK_THRIFT_PORT=10000
SPARK_MASTER_WEBUI=http://localhost:8080
SPARK_WORKER_WEBUI=http://localhost:8081
SPARK_HISTORY_WEBUI=http://localhost:18080

# gRPC Data Extract Service
GRPC_HOST=localhost
GRPC_PORT=50051
ENVEOF
    ok ".env created"
else
    ok ".env already exists"
fi

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}Setup complete!${NC}"
echo ""
echo "Next steps:"
echo "  1. Start Spark:       ./scripts/spark-manager.sh start"
echo "  2. Start platform:    ./scripts/dev.sh"
echo "  3. Open frontend:     http://localhost:3000"
echo "  4. Open API docs:     http://localhost:8000/docs"
echo ""
