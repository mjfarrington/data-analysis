#!/usr/bin/env bash
# =============================================================================
# Dev launcher — starts all platform services in separate terminal panes
# Usage: ./scripts/dev.sh [--no-spark] [--no-grpc] [--no-frontend]
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

START_SPARK=true
START_GRPC=true
START_BACKEND=true
START_FRONTEND=true

for arg in "$@"; do
  case "$arg" in
    --no-spark)    START_SPARK=false ;;
    --no-grpc)     START_GRPC=false ;;
    --no-frontend) START_FRONTEND=false ;;
    --no-backend)  START_BACKEND=false ;;
  esac
done

LOG_DIR="$PROJECT_DIR/logs"
mkdir -p "$LOG_DIR"/{backend,grpc}

# ─────────────────────────────────────────────────────────────────────────────
echo -e "${BOLD}${CYAN}"
echo " ╔═══════════════════════════════════════╗"
echo " ║   Data Analysis Platform — Dev Mode  ║"
echo " ╚═══════════════════════════════════════╝"
echo -e "${NC}"

# ─────────────────────────────────────────────────────────────────────────────
# 1. Spark
if [[ "$START_SPARK" == "true" ]]; then
    echo -e "${BLUE}[1/4]${NC} Starting Spark cluster..."
    "$SCRIPT_DIR/spark-manager.sh" start all 2>&1 | grep -E "OK|WARN|ERROR|Master|Worker|Thrift|Connect|History" || true
    echo ""
fi

# ─────────────────────────────────────────────────────────────────────────────
# 2. gRPC dummy server (background)
if [[ "$START_GRPC" == "true" ]]; then
    echo -e "${BLUE}[2/4]${NC} Starting gRPC Data Extract server..."
    GRPC_LOG="$LOG_DIR/grpc/server.log"
    GRPC_PID_FILE="$LOG_DIR/grpc/server.pid"

    if [[ -f "$GRPC_PID_FILE" ]] && kill -0 "$(cat "$GRPC_PID_FILE")" 2>/dev/null; then
        echo -e "  ${YELLOW}gRPC server already running (PID $(cat "$GRPC_PID_FILE"))${NC}"
    else
        PYTHONPATH="$PROJECT_DIR/grpc" \
        "$PROJECT_DIR/grpc/.venv/bin/python" "$PROJECT_DIR/grpc/server.py" \
            > "$GRPC_LOG" 2>&1 &
        GRPC_PID=$!
        echo $GRPC_PID > "$GRPC_PID_FILE"

        # Wait for it to be ready
        for i in $(seq 1 10); do
            if lsof -i :50051 -sTCP:LISTEN -t >/dev/null 2>&1; then
                echo -e "  ${GREEN}gRPC server started (PID $GRPC_PID) — port 50051${NC}"
                break
            fi
            sleep 0.5
        done
        if ! lsof -i :50051 -sTCP:LISTEN -t >/dev/null 2>&1; then
            echo -e "  ${RED}gRPC server failed to start — check $GRPC_LOG${NC}"
        fi
    fi
    echo ""
fi

# ─────────────────────────────────────────────────────────────────────────────
# 3. FastAPI backend (background)
if [[ "$START_BACKEND" == "true" ]]; then
    echo -e "${BLUE}[3/4]${NC} Starting FastAPI backend..."
    BACKEND_LOG="$LOG_DIR/backend/app.log"
    BACKEND_PID_FILE="$LOG_DIR/backend/app.pid"

    if [[ -f "$BACKEND_PID_FILE" ]] && kill -0 "$(cat "$BACKEND_PID_FILE")" 2>/dev/null; then
        echo -e "  ${YELLOW}Backend already running (PID $(cat "$BACKEND_PID_FILE"))${NC}"
    else
        cd "$PROJECT_DIR/backend"
        PYTHONPATH="$PROJECT_DIR/backend:$PROJECT_DIR/grpc" \
        "$PROJECT_DIR/backend/.venv/bin/uvicorn" app.main:app \
            --host 0.0.0.0 \
            --port 8000 \
            --reload \
            --log-level info \
            > "$BACKEND_LOG" 2>&1 &
        BACKEND_PID=$!
        echo $BACKEND_PID > "$BACKEND_PID_FILE"
        cd "$PROJECT_DIR"

        for i in $(seq 1 15); do
            if curl -sf http://localhost:8000/health >/dev/null 2>&1; then
                echo -e "  ${GREEN}Backend started (PID $BACKEND_PID) — http://localhost:8000${NC}"
                echo -e "  ${CYAN}  API docs: http://localhost:8000/docs${NC}"
                break
            fi
            sleep 0.5
        done
        if ! curl -sf http://localhost:8000/health >/dev/null 2>&1; then
            echo -e "  ${YELLOW}Backend starting up — check $BACKEND_LOG${NC}"
        fi
    fi
    echo ""
fi

# ─────────────────────────────────────────────────────────────────────────────
# 4. React frontend (background)
if [[ "$START_FRONTEND" == "true" ]]; then
    echo -e "${BLUE}[4/4]${NC} Starting React frontend (Vite)..."
    FRONTEND_LOG="$LOG_DIR/frontend.log"
    FRONTEND_PID_FILE="$LOG_DIR/frontend.pid"

    if [[ -f "$FRONTEND_PID_FILE" ]] && kill -0 "$(cat "$FRONTEND_PID_FILE")" 2>/dev/null; then
        echo -e "  ${YELLOW}Frontend already running (PID $(cat "$FRONTEND_PID_FILE"))${NC}"
    else
        (cd "$PROJECT_DIR/frontend" && npm run dev > "$FRONTEND_LOG" 2>&1) &
        FRONTEND_PID=$!
        echo $FRONTEND_PID > "$FRONTEND_PID_FILE"

        for i in $(seq 1 20); do
            if lsof -i :3000 -sTCP:LISTEN -t >/dev/null 2>&1; then
                echo -e "  ${GREEN}Frontend started (PID $FRONTEND_PID) — http://localhost:3000${NC}"
                break
            fi
            sleep 0.5
        done
        if ! lsof -i :3000 -sTCP:LISTEN -t >/dev/null 2>&1; then
            echo -e "  ${YELLOW}Frontend starting — check $FRONTEND_LOG${NC}"
        fi
    fi
    echo ""
fi

# ─────────────────────────────────────────────────────────────────────────────
echo -e "${BOLD}${GREEN}All services launched!${NC}"
echo ""
echo -e "  ${BOLD}Frontend${NC}        http://localhost:3000"
echo -e "  ${BOLD}API${NC}             http://localhost:8000"
echo -e "  ${BOLD}API Docs${NC}        http://localhost:8000/docs"
echo -e "  ${BOLD}Spark Master${NC}    http://localhost:8080"
echo -e "  ${BOLD}Spark Worker${NC}    http://localhost:8081"
echo -e "  ${BOLD}Spark History${NC}   http://localhost:18080"
echo -e "  ${BOLD}gRPC Service${NC}    localhost:50051"
echo ""
echo -e "Logs: $LOG_DIR/"
echo "Stop: ./scripts/stop.sh"
echo ""
