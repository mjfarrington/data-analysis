#!/usr/bin/env bash
# Stop all platform services
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$PROJECT_DIR/logs"

RED='\033[0;31m'; GREEN='\033[0;32m'; BLUE='\033[0;34m'; NC='\033[0m'

stop_pid_file() {
    local name=$1
    local pid_file=$2
    if [[ -f "$pid_file" ]]; then
        local pid
        pid=$(cat "$pid_file")
        if kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null && echo -e "${GREEN}[stopped]${NC} $name (PID $pid)"
        else
            echo -e "${BLUE}[already stopped]${NC} $name"
        fi
        rm -f "$pid_file"
    else
        echo -e "${BLUE}[not running]${NC} $name"
    fi
}

echo "Stopping platform services..."
stop_pid_file "Frontend"   "$LOG_DIR/frontend.pid"
stop_pid_file "Backend"    "$LOG_DIR/backend/app.pid"

# Clear stale port processes
for port in 8000 5173; do
    stale=$(lsof -ti :$port 2>/dev/null || true)
    [[ -n "$stale" ]] && kill -9 $stale 2>/dev/null || true
done

echo ""
echo "Stopping Spark..."
"$SCRIPT_DIR/spark-manager.sh" stop all

echo ""
echo -e "${GREEN}All services stopped.${NC}"
