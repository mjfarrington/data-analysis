#!/usr/bin/env bash
# =============================================================================
# platform.sh — Unified Data Analysis Platform control script
#
# Usage:
#   ./scripts/platform.sh start   [all|spark|backend|frontend]
#   ./scripts/platform.sh stop    [all|spark|backend|frontend]
#   ./scripts/platform.sh restart [all|spark|backend|frontend]
#   ./scripts/platform.sh status
#   ./scripts/platform.sh monitor          # live-refresh status board
#   ./scripts/platform.sh logs  <service>  # tail service logs
#   ./scripts/platform.sh health           # hit the backend health API
#
# Spark sub-services (via spark-manager.sh):
#   ./scripts/platform.sh start  spark:master|worker|thrift|connect|history
#   ./scripts/platform.sh stop   spark:master|worker|thrift|connect|history
#   ./scripts/platform.sh restart spark:master|worker|thrift|connect|history
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$PROJECT_DIR/var/logs"
mkdir -p "$LOG_DIR/backend"

# Spark manager delegate
SPARK_MGR="$SCRIPT_DIR/spark-manager.sh"

# ─── Colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# ─── Helpers ──────────────────────────────────────────────────────────────────
info()    { echo -e "${BLUE}[INFO]${NC}  $*"; }
ok()      { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()     { echo -e "${RED}[ERROR]${NC} $*" >&2; }
header()  { echo -e "\n${BOLD}${CYAN}── $* ──${NC}"; }

port_up() { lsof -i :"$1" -sTCP:LISTEN -t >/dev/null 2>&1; }
http_ok() { curl -sf --max-time 3 "$1" >/dev/null 2>&1; }

# Return PID using port, or empty string
port_pid() { lsof -i :"$1" -sTCP:LISTEN -t 2>/dev/null | head -1 || true; }

pid_running() {
    local pf=$1
    [[ -f "$pf" ]] && kill -0 "$(cat "$pf")" 2>/dev/null
}

stop_pid_file() {
    local name=$1 pf=$2
    if pid_running "$pf"; then
        local pid; pid=$(cat "$pf")
        kill "$pid" 2>/dev/null && ok "$name stopped (PID $pid)"
        rm -f "$pf"
    else
        echo -e "  ${DIM}$name not running${NC}"
        rm -f "$pf"
    fi
}

wait_for_port() {
    local name=$1 port=$2 max=${3:-20}
    for ((i=1; i<=max; i++)); do
        port_up "$port" && return 0
        printf '.'
        sleep 0.5
    done
    echo
    warn "$name did not start on port $port within ${max}s"
    return 1
}

# ─── Service: Backend ─────────────────────────────────────────────────────────
backend_start() {
    header "FastAPI Backend"
    local pf="$LOG_DIR/backend/app.pid"
    if pid_running "$pf"; then
        warn "Backend already running (PID $(cat "$pf"))"; return 0
    fi
    # Clear stale port occupant (previous crashed uvicorn)
    local stale; stale=$(lsof -ti :8000 2>/dev/null || true)
    [[ -n "$stale" ]] && { echo "  Clearing stale process on :8000"; kill -9 $stale 2>/dev/null || true; sleep 0.5; }

    cd "$PROJECT_DIR/backend"
    PYTHONPATH="$PROJECT_DIR/backend" \
    "$PROJECT_DIR/backend/.venv/bin/uvicorn" app.main:app \
        --host 0.0.0.0 --port 8000 --reload --log-level info \
        >> "$LOG_DIR/backend/app.log" 2>&1 &
    local pid=$!; echo $pid > "$pf"
    cd "$PROJECT_DIR"
    printf "  Waiting"
    for ((i=1; i<=30; i++)); do
        http_ok "http://localhost:8000/health" && break
        printf '.'; sleep 0.5
    done
    echo
    if http_ok "http://localhost:8000/health"; then
        ok "Backend started (PID $pid) — http://localhost:8000"
    else
        warn "Backend may still be starting — check var/logs/backend/app.log"
    fi
}

backend_stop() {
    header "Stop Backend"
    stop_pid_file "Backend" "$LOG_DIR/backend/app.pid"
    # Also kill any stale uvicorn on port 8000
    local stale; stale=$(lsof -ti :8000 2>/dev/null || true)
    [[ -n "$stale" ]] && kill -9 $stale 2>/dev/null && ok "Cleared stale process on :8000" || true
}

# ─── Service: Frontend ────────────────────────────────────────────────────────
frontend_start() {
    header "React Frontend (Vite)"
    local pf="$LOG_DIR/frontend.pid"
    if pid_running "$pf"; then
        warn "Frontend already running (PID $(cat "$pf"))"; return 0
    fi
    (cd "$PROJECT_DIR/frontend" && npm run dev >> "$LOG_DIR/frontend.log" 2>&1) &
    local pid=$!; echo $pid > "$pf"
    printf "  Waiting"; wait_for_port "Frontend" 5173 30 && ok "Frontend started (PID $pid) — http://localhost:5173"
}

frontend_stop() {
    header "Stop Frontend"
    stop_pid_file "Frontend" "$LOG_DIR/frontend.pid"
    local stale; stale=$(lsof -ti :5173 2>/dev/null || true)
    [[ -n "$stale" ]] && kill -9 $stale 2>/dev/null && ok "Cleared stale process on :5173" || true
}

# ─── Start / Stop dispatchers ────────────────────────────────────────────────
do_start() {
    local svc="${1:-all}"
    case "$svc" in
        all)
            "$SPARK_MGR" start all
            backend_start
            frontend_start
            ;;
        spark) "$SPARK_MGR" start all ;;
        spark:*) "$SPARK_MGR" start "${svc#spark:}" ;;
        backend)  backend_start ;;
        frontend) frontend_start ;;
        *) err "Unknown service: $svc"; usage; exit 1 ;;
    esac
}

do_stop() {
    local svc="${1:-all}"
    case "$svc" in
        all)
            frontend_stop
            backend_stop
            "$SPARK_MGR" stop all
            ;;
        spark) "$SPARK_MGR" stop all ;;
        spark:*) "$SPARK_MGR" stop "${svc#spark:}" ;;
        backend)  backend_stop ;;
        frontend) frontend_stop ;;
        *) err "Unknown service: $svc"; usage; exit 1 ;;
    esac
}

do_restart() {
    local svc="${1:-all}"
    do_stop "$svc"
    sleep 1
    do_start "$svc"
}

# ─── Status ───────────────────────────────────────────────────────────────────
service_line() {
    local label=$1 port=$2 url=${3:-} pid_file=${4:-}
    local UP="${GREEN}●${NC}" DOWN="${RED}●${NC}" UNKNOWN="${YELLOW}●${NC}"
    local pid=''

    if [[ -n "$pid_file" ]] && pid_running "$pid_file"; then
        pid="PID $(cat "$pid_file")"
    fi

    if port_up "$port"; then
        local actual_pid; actual_pid=$(port_pid "$port")
        [[ -z "$pid" && -n "$actual_pid" ]] && pid="PID $actual_pid"
        printf "  ${UP} %-22s port %-6s %s\n" "$label" "$port" "${pid:+$pid}"
        [[ -n "$url" ]] && printf "    ${DIM}%-30s${NC}\n" "$url"
    else
        printf "  ${DOWN} %-22s ${DIM}not listening on :-%-6s${NC}\n" "$label" "$port"
    fi
    return 0
}

http_line() {
    local label=$1 url=$2
    local OK="${GREEN}●${NC}" FAIL="${RED}●${NC}"
    if http_ok "$url"; then
        printf "  ${OK} %-22s %s\n" "$label" "$url"
    else
        printf "  ${FAIL} %-22s ${DIM}unreachable: %s${NC}\n" "$label" "$url"
    fi
}

do_status() {
    echo -e "${BOLD}${CYAN}"
    echo "  ╔══════════════════════════════════════════╗"
    echo "  ║     Data Analysis Platform — Status     ║"
    printf "  ║  ${DIM}%-42s${BOLD}${CYAN}║\n" "$(date +'%Y-%m-%d %H:%M:%S')"
    echo "  ╚══════════════════════════════════════════╝"
    echo -e "${NC}"

    echo -e "${BOLD}  Spark Cluster${NC}"
    service_line "Master"         7077  "http://localhost:8080"
    service_line "Worker"         8081  "http://localhost:8081"
    service_line "ThriftServer"   10000 "jdbc:hive2://localhost:10000"
    service_line "Connect (gRPC)" 15002 "sc://localhost:15002"
    service_line "History Server" 18080 "http://localhost:18080"

    echo -e "\n${BOLD}  Platform Services${NC}"
    service_line "FastAPI Backend"  8000  "http://localhost:8000"     "$LOG_DIR/backend/app.pid"
    service_line "React Frontend"   5173  "http://localhost:5173"     "$LOG_DIR/frontend.pid"

    echo -e "\n${BOLD}  API Health${NC}"
    if http_ok "http://localhost:8000/health"; then
        local resp uptime
        resp=$(curl -sf --max-time 3 "http://localhost:8000/health" 2>/dev/null) || resp='{}'
        uptime=$(echo "$resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f\"{d.get('uptime_seconds',0)}s\")" 2>/dev/null) || uptime=""
        printf "  ${GREEN}●${NC} %-22s %s\n" "Backend /health" "${uptime:+uptime $uptime}"
    else
        printf "  ${RED}●${NC} %-22s %s\n" "Backend /health" "not reachable"
    fi

    echo ""
}

# ─── Monitor ─────────────────────────────────────────────────────────────────
do_monitor() {
    echo -e "${CYAN}Monitoring services — press Ctrl+C to exit${NC}"
    while true; do
        clear
        do_status
        echo -e "${DIM}  Refreshing every 5s — Ctrl+C to quit${NC}"
        sleep 5
    done
}

# ─── Health ───────────────────────────────────────────────────────────────────
do_health() {
    header "Backend API Health"
    if ! http_ok "http://localhost:8000/health"; then
        err "Backend is not reachable at http://localhost:8000"; exit 1
    fi
    curl -sf "http://localhost:8000/health" | python3 -m json.tool
    echo ""
    header "Services Status (via API)"
    curl -sf "http://localhost:8000/api/v1/services/status" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f\"  Overall: {d['overall'].upper()}\")
for s in d['services']:
    icon = '✓' if s['status']=='healthy' else ('~' if s['status']=='degraded' else '✗')
    lat = f\"  {s.get('latency_ms',0):.0f}ms\" if s.get('latency_ms') else ''
    print(f\"  {icon} {s['name']:<25} {s['status']:<10}{lat}\")
    if s.get('message') and s['status'] != 'healthy':
        print(f\"    → {s['message']}\")
"
    echo ""
}

# ─── Logs ─────────────────────────────────────────────────────────────────────
do_logs() {
    local svc="${1:-backend}" lines="${2:-100}"
    case "$svc" in
        backend)   tail -n "$lines" -f "$LOG_DIR/backend/app.log" ;;
        frontend)  tail -n "$lines" -f "$LOG_DIR/frontend.log" ;;
        spark:master|master)
            local f; f=$(ls -t "$PROJECT_DIR/var/logs/spark/"*Worker* 2>/dev/null | head -1 || true)
            local f; f=$(ls -t "$PROJECT_DIR/var/logs/spark/"spark-*-org.apache.spark.deploy.master* 2>/dev/null | head -1 || true)
            [[ -n "$f" ]] && tail -n "$lines" -f "$f" || err "No master log found" ;;
        spark:worker|worker)
            local f; f=$(ls -t "$PROJECT_DIR/var/logs/spark/"*worker* 2>/dev/null | head -1 || true)
            [[ -n "$f" ]] && tail -n "$lines" -f "$f" || err "No worker log found" ;;
        spark:thrift|thrift)
            "$SPARK_MGR" logs thrift "$lines" ;;
        spark:connect|connect)
            "$SPARK_MGR" logs connect "$lines" ;;
        *)
            err "Unknown log target: $svc"
            echo "  Available: backend, frontend, master, worker, thrift, connect"
            exit 1 ;;
    esac
}

# ─── Usage ────────────────────────────────────────────────────────────────────
usage() {
    echo -e "${BOLD}Usage:${NC}"
    echo "  ./scripts/platform.sh <command> [target]"
    echo ""
    echo -e "${BOLD}Commands:${NC}"
    echo "  start   [all|spark|backend|frontend]    Start service(s)"
    echo "  stop    [all|spark|backend|frontend]    Stop service(s)"
    echo "  restart [all|spark|backend|frontend]    Restart service(s)"
    echo "  status                                        Show all service status"
    echo "  monitor                                       Live-refreshing status board"
    echo "  health                                        Query backend health API"
    echo "  logs    <backend|frontend|thrift|...>   Tail logs"
    echo ""
    echo -e "${BOLD}Spark sub-services:${NC}"
    echo "  ./scripts/platform.sh start  spark:master|worker|thrift|connect|history"
    echo "  ./scripts/platform.sh stop   spark:master|worker|thrift|connect|history"
    echo "  ./scripts/platform.sh restart spark:connect"
    echo ""
    echo -e "${BOLD}Examples:${NC}"
    echo "  ./scripts/platform.sh start              # start everything"
    echo "  ./scripts/platform.sh stop               # stop everything"
    echo "  ./scripts/platform.sh restart backend    # restart just the API"
    echo "  ./scripts/platform.sh restart spark:connect"
    echo "  ./scripts/platform.sh monitor            # live status board"
    echo "  ./scripts/platform.sh health             # API health check"
    echo "  ./scripts/platform.sh logs backend       # tail backend logs"
}

# ─── Entry point ─────────────────────────────────────────────────────────────
CMD="${1:-help}"
shift || true
TARGET="${1:-all}"

case "$CMD" in
    start)    do_start   "$TARGET" ;;
    stop)     do_stop    "$TARGET" ;;
    restart)  do_restart "$TARGET" ;;
    status)   do_status ;;
    monitor)  do_monitor ;;
    health)   do_health ;;
    logs)     do_logs    "${1:-backend}" "${2:-100}" ;;
    help|--help|-h) usage ;;
    *)
        err "Unknown command: $CMD"
        usage
        exit 1 ;;
esac
