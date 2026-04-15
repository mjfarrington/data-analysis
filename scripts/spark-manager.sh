#!/usr/bin/env bash
# =============================================================================
# Spark 4.0 Service Manager
# Manages: Master, Worker, ThriftServer, Connect Server
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SPARK_HOME="${SPARK_HOME:-$PROJECT_DIR/spark}"
SPARK_MASTER_HOST="${SPARK_MASTER_HOST:-localhost}"
SPARK_MASTER_PORT="${SPARK_MASTER_PORT:-7077}"
SPARK_MASTER_WEBUI_PORT="${SPARK_MASTER_WEBUI_PORT:-8080}"
SPARK_WORKER_WEBUI_PORT="${SPARK_WORKER_WEBUI_PORT:-8081}"
SPARK_THRIFT_PORT="${SPARK_THRIFT_PORT:-10000}"
SPARK_CONNECT_PORT="${SPARK_CONNECT_PORT:-15002}"
SPARK_HISTORY_PORT="${SPARK_HISTORY_PORT:-18080}"
SPARK_MASTER_URL="spark://${SPARK_MASTER_HOST}:${SPARK_MASTER_PORT}"

DATA_DIR="${PROJECT_DIR}/data"
LOG_DIR="${PROJECT_DIR}/logs/spark"
SPARK_EVENTS_DIR="${DATA_DIR}/spark-events"

export SPARK_HOME
export SPARK_LOG_DIR="${LOG_DIR}"
export SPARK_PID_DIR="${LOG_DIR}/pid"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# =============================================================================
# Utility Functions
# =============================================================================
log_info()    { echo -e "${BLUE}[INFO]${NC}  $*"; }
log_success() { echo -e "${GREEN}[OK]${NC}    $*"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }
log_header()  { echo -e "\n${BOLD}${CYAN}==> $*${NC}"; }

check_spark_home() {
    if [[ ! -d "$SPARK_HOME" ]]; then
        log_error "SPARK_HOME not found: $SPARK_HOME"
        log_error "Please set SPARK_HOME or ensure spark/ symlink exists."
        exit 1
    fi
    if [[ ! -x "$SPARK_HOME/sbin/start-master.sh" ]]; then
        log_error "Spark sbin scripts not found/executable in $SPARK_HOME/sbin"
        exit 1
    fi
}

init_dirs() {
    mkdir -p "$LOG_DIR" "$SPARK_PID_DIR" "$SPARK_EVENTS_DIR"
    mkdir -p "$DATA_DIR/extracts" "$DATA_DIR/parquet" "$DATA_DIR/csv"
}

check_port() {
    local port=$1
    if lsof -i ":${port}" -sTCP:LISTEN -t >/dev/null 2>&1; then
        return 0  # port is in use (service running)
    fi
    return 1  # port is free
}

wait_for_port() {
    local service=$1
    local port=$2
    local max_wait=${3:-30}
    local elapsed=0
    printf "${BLUE}[INFO]${NC}  Waiting for %s on port %s" "$service" "$port"
    while ! check_port "$port"; do
        sleep 1
        elapsed=$((elapsed + 1))
        printf "."
        if [[ $elapsed -ge $max_wait ]]; then
            echo ""
            log_error "$service did not start within ${max_wait}s"
            return 1
        fi
    done
    echo ""
    log_success "$service is listening on port $port"
    return 0
}

get_pid_from_port() {
    local port=$1
    lsof -i ":${port}" -sTCP:LISTEN -t 2>/dev/null | head -1 || true
}

service_status_line() {
    local name=$1
    local port=$2
    local webui=$3
    if check_port "$port"; then
        local pid
        pid=$(get_pid_from_port "$port")
        echo -e "  ${GREEN}●${NC} ${BOLD}${name}${NC} — port ${port} — PID ${pid:-?}${WEBUI:+ — ${webui}}"
    else
        echo -e "  ${RED}○${NC} ${BOLD}${name}${NC} — port ${port} — STOPPED"
    fi
}

# =============================================================================
# Install Spark configuration from conf/spark/ (tracked in git) → SPARK_HOME/conf/
# =============================================================================
CONF_SOURCE_DIR="${PROJECT_DIR}/conf/spark"

install_spark_conf() {
    local src="${CONF_SOURCE_DIR}/spark-defaults.conf"
    local dst="${SPARK_HOME}/conf/spark-defaults.conf"

    if [[ ! -f "$src" ]]; then
        log_error "Source config not found: $src"
        exit 1
    fi

    log_info "Installing spark-defaults.conf from conf/spark/ ..."
    # Substitute ${PROJECT_DIR} and ${SPARK_HOME} placeholders
    sed \
        -e "s|\${PROJECT_DIR}|${PROJECT_DIR}|g" \
        -e "s|\${SPARK_HOME}|${SPARK_HOME}|g" \
        -e "s|spark.connect.grpc.binding.port       15002|spark.connect.grpc.binding.port       ${SPARK_CONNECT_PORT}|g" \
        -e "s|spark.master                          spark://localhost:7077|spark.master                          ${SPARK_MASTER_URL}|g" \
        "$src" > "$dst"
    log_success "spark-defaults.conf installed → $dst"

    # Copy log4j2.properties
    local log4j_src="${CONF_SOURCE_DIR}/log4j2.properties"
    local log4j_dst="${SPARK_HOME}/conf/log4j2.properties"
    if [[ -f "$log4j_src" ]]; then
        cp "$log4j_src" "$log4j_dst"
        log_success "log4j2.properties installed → $log4j_dst"
    fi
}

# =============================================================================
# Start Commands
# =============================================================================
start_master() {
    log_header "Starting Spark Master"
    if check_port "$SPARK_MASTER_PORT"; then
        log_warn "Master already running on port $SPARK_MASTER_PORT"
        return 0
    fi
    "$SPARK_HOME/sbin/start-master.sh" \
        --host "$SPARK_MASTER_HOST" \
        --port "$SPARK_MASTER_PORT" \
        --webui-port "$SPARK_MASTER_WEBUI_PORT"
    wait_for_port "Spark Master" "$SPARK_MASTER_PORT" 30
    log_success "Master UI: http://${SPARK_MASTER_HOST}:${SPARK_MASTER_WEBUI_PORT}"
}

start_worker() {
    log_header "Starting Spark Worker"
    if check_port "$SPARK_WORKER_WEBUI_PORT"; then
        log_warn "Worker already running on port $SPARK_WORKER_WEBUI_PORT"
        return 0
    fi
    "$SPARK_HOME/sbin/start-worker.sh" \
        "$SPARK_MASTER_URL" \
        --cores "${SPARK_WORKER_CORES:-8}" \
        --memory "${SPARK_WORKER_MEMORY:-8g}" \
        --webui-port "$SPARK_WORKER_WEBUI_PORT"
    wait_for_port "Spark Worker" "$SPARK_WORKER_WEBUI_PORT" 30
    log_success "Worker UI: http://${SPARK_MASTER_HOST}:${SPARK_WORKER_WEBUI_PORT}"
}

start_thriftserver() {
    log_header "Starting Spark ThriftServer (HiveServer2)"
    if check_port "$SPARK_THRIFT_PORT"; then
        log_warn "ThriftServer already running on port $SPARK_THRIFT_PORT"
        return 0
    fi
    "$SPARK_HOME/sbin/start-thriftserver.sh" \
        --master "$SPARK_MASTER_URL" \
        --hiveconf hive.server2.thrift.port="$SPARK_THRIFT_PORT" \
        --conf spark.sql.warehouse.dir="${DATA_DIR}/spark-warehouse"
    wait_for_port "ThriftServer" "$SPARK_THRIFT_PORT" 60
    log_success "ThriftServer JDBC: jdbc:hive2://localhost:${SPARK_THRIFT_PORT}"
}

start_connect() {
    log_header "Starting Spark Connect Server"
    if check_port "$SPARK_CONNECT_PORT"; then
        log_warn "Connect Server already running on port $SPARK_CONNECT_PORT"
        return 0
    fi
    "$SPARK_HOME/sbin/start-connect-server.sh" \
        --master "$SPARK_MASTER_URL" \
        --conf spark.connect.grpc.binding.port="$SPARK_CONNECT_PORT"
    wait_for_port "Spark Connect" "$SPARK_CONNECT_PORT" 60
    log_success "Connect gRPC: localhost:${SPARK_CONNECT_PORT}"
}

start_history() {
    log_header "Starting Spark History Server"
    if check_port "$SPARK_HISTORY_PORT"; then
        log_warn "History Server already running on port $SPARK_HISTORY_PORT"
        return 0
    fi
    export SPARK_HISTORY_OPTS="-Dspark.history.fs.logDirectory=file://${SPARK_EVENTS_DIR} -Dspark.history.ui.port=${SPARK_HISTORY_PORT}"
    "$SPARK_HOME/sbin/start-history-server.sh"
    wait_for_port "Spark History" "$SPARK_HISTORY_PORT" 30
    log_success "History UI: http://${SPARK_MASTER_HOST}:${SPARK_HISTORY_PORT}"
}

# =============================================================================
# Stop Commands
# =============================================================================
stop_master() {
    log_header "Stopping Spark Master"
    "$SPARK_HOME/sbin/stop-master.sh" 2>/dev/null || true
    sleep 2
    if ! check_port "$SPARK_MASTER_PORT"; then
        log_success "Master stopped"
    else
        log_warn "Master may still be running — killing by port"
        kill_by_port "$SPARK_MASTER_PORT"
    fi
}

stop_worker() {
    log_header "Stopping Spark Worker"
    "$SPARK_HOME/sbin/stop-worker.sh" 2>/dev/null || true
    sleep 2
    log_success "Worker stopped"
}

stop_thriftserver() {
    log_header "Stopping ThriftServer"
    "$SPARK_HOME/sbin/stop-thriftserver.sh" 2>/dev/null || true
    sleep 2
    if ! check_port "$SPARK_THRIFT_PORT"; then
        log_success "ThriftServer stopped"
    else
        kill_by_port "$SPARK_THRIFT_PORT"
    fi
}

stop_connect() {
    log_header "Stopping Spark Connect Server"
    "$SPARK_HOME/sbin/stop-connect-server.sh" 2>/dev/null || true
    sleep 2
    if ! check_port "$SPARK_CONNECT_PORT"; then
        log_success "Connect Server stopped"
    else
        kill_by_port "$SPARK_CONNECT_PORT"
    fi
}

stop_history() {
    log_header "Stopping Spark History Server"
    "$SPARK_HOME/sbin/stop-history-server.sh" 2>/dev/null || true
    log_success "History Server stopped"
}

kill_by_port() {
    local port=$1
    local pid
    pid=$(get_pid_from_port "$port")
    if [[ -n "$pid" ]]; then
        log_warn "Force-killing PID $pid on port $port"
        kill -9 "$pid" 2>/dev/null || true
        sleep 1
        log_success "Killed PID $pid"
    fi
}

# =============================================================================
# Status
# =============================================================================
print_status() {
    log_header "Spark Service Status"
    echo ""
    service_status_line "Master        " "$SPARK_MASTER_PORT"  "http://localhost:${SPARK_MASTER_WEBUI_PORT}"
    service_status_line "Worker        " "$SPARK_WORKER_WEBUI_PORT" "http://localhost:${SPARK_WORKER_WEBUI_PORT}"
    service_status_line "ThriftServer  " "$SPARK_THRIFT_PORT" ""
    service_status_line "Connect Server" "$SPARK_CONNECT_PORT" ""
    service_status_line "History Server" "$SPARK_HISTORY_PORT" "http://localhost:${SPARK_HISTORY_PORT}"
    echo ""
    echo -e "${BOLD}Web UIs:${NC}"
    echo -e "  Master   : http://localhost:${SPARK_MASTER_WEBUI_PORT}"
    echo -e "  Worker   : http://localhost:${SPARK_WORKER_WEBUI_PORT}"
    echo -e "  History  : http://localhost:${SPARK_HISTORY_PORT}"
    echo -e "  JDBC/ODBC: jdbc:hive2://localhost:${SPARK_THRIFT_PORT}"
    echo -e "  Connect  : localhost:${SPARK_CONNECT_PORT} (gRPC)"
    echo ""
}

# =============================================================================
# Test connections
# =============================================================================
test_connections() {
    log_header "Testing Spark Connections"

    # Test Master REST API
    local master_url="http://localhost:${SPARK_MASTER_WEBUI_PORT}/api/v1/applications"
    if curl -sf "$master_url" -o /dev/null 2>/dev/null; then
        log_success "Spark Master REST API responding"
    else
        log_error "Spark Master REST API not responding at $master_url"
    fi

    # Test ThriftServer via beeline
    if check_port "$SPARK_THRIFT_PORT"; then
        log_success "ThriftServer port $SPARK_THRIFT_PORT is open"
        if command -v beeline &>/dev/null || [[ -x "$SPARK_HOME/bin/beeline" ]]; then
            local result
            result=$("$SPARK_HOME/bin/beeline" \
                -u "jdbc:hive2://localhost:${SPARK_THRIFT_PORT}" \
                -e "SHOW DATABASES;" 2>&1 | tail -5)
            if echo "$result" | grep -q "default\|Row"; then
                log_success "ThriftServer JDBC connection OK"
                echo "    Databases: $(echo "$result" | grep -v '^$' | head -3)"
            else
                log_warn "ThriftServer responded but query failed: $result"
            fi
        fi
    else
        log_error "ThriftServer port $SPARK_THRIFT_PORT is closed"
    fi

    # Test Connect gRPC
    if check_port "$SPARK_CONNECT_PORT"; then
        log_success "Spark Connect gRPC port $SPARK_CONNECT_PORT is open"
    else
        log_error "Spark Connect port $SPARK_CONNECT_PORT is closed"
    fi

    # Python connect test
    if command -v python3 &>/dev/null; then
        python3 - <<PYEOF 2>&1 | head -5
try:
    from pyspark.sql import SparkSession
    spark = SparkSession.builder.remote("sc://localhost:${SPARK_CONNECT_PORT}").getOrCreate()
    v = spark.sql("SELECT 1 AS test").collect()
    print("Spark Connect Python OK:", v)
    spark.stop()
except Exception as e:
    print("Spark Connect Python FAILED:", e)
PYEOF
    fi
}

# =============================================================================
# Logs
# =============================================================================
show_logs() {
    local service=${1:-master}
    local lines=${2:-100}
    log_header "Logs for: $service (last $lines lines)"
    local log_file
    case "$service" in
        master)   log_file=$(ls -t "$LOG_DIR"/spark-*-org.apache.spark.deploy.master.Master-*.out 2>/dev/null | head -1) ;;
        worker)   log_file=$(ls -t "$LOG_DIR"/spark-*-org.apache.spark.deploy.worker.Worker-*.out 2>/dev/null | head -1) ;;
        thrift)   log_file=$(ls -t "$LOG_DIR"/spark-*-org.apache.spark.sql.hive.thriftserver.HiveThriftServer2-*.out 2>/dev/null | head -1) ;;
        connect)  log_file=$(ls -t "$LOG_DIR"/spark-*-org.apache.spark.sql.connect.service.SparkConnectServer-*.out 2>/dev/null | head -1) ;;
        history)  log_file=$(ls -t "$LOG_DIR"/spark-*-org.apache.spark.deploy.history.HistoryServer-*.out 2>/dev/null | head -1) ;;
        *)        log_error "Unknown service: $service (master|worker|thrift|connect|history)"; exit 1 ;;
    esac
    if [[ -f "$log_file" ]]; then
        tail -n "$lines" "$log_file"
    else
        log_warn "No log file found for $service in $LOG_DIR"
        log_info "Available logs:"
        ls -la "$LOG_DIR"/*.out 2>/dev/null || echo "  (none)"
    fi
}

# =============================================================================
# Main Entry Point
# =============================================================================
usage() {
    cat <<EOF

${BOLD}${CYAN}Spark 4.0 Service Manager${NC}

${BOLD}Usage:${NC}
  $(basename "$0") <command> [options]

${BOLD}Commands:${NC}
  start [all|master|worker|thrift|connect|history]
        Start one or all services (default: all)

  stop  [all|master|worker|thrift|connect|history]
        Stop one or all services (default: all)

  restart [service]
        Restart one or all services

  status
        Show status of all services

  test
        Test all service connections

  logs  [master|worker|thrift|connect|history] [lines]
        Tail service logs (default: master, 100 lines)

  config
        Write/refresh spark-defaults.conf

${BOLD}Environment:${NC}
  SPARK_HOME            $SPARK_HOME
  SPARK_MASTER_URL      $SPARK_MASTER_URL
  SPARK_THRIFT_PORT     $SPARK_THRIFT_PORT
  SPARK_CONNECT_PORT    $SPARK_CONNECT_PORT

EOF
}

main() {
    check_spark_home
    init_dirs

    local cmd=${1:-help}
    local target=${2:-all}

    case "$cmd" in
        start)
            install_spark_conf
            case "$target" in
                all)     start_master; start_worker; start_connect; start_thriftserver; start_history ;;
                master)  start_master ;;
                worker)  start_worker ;;
                thrift)  start_thriftserver ;;
                connect) start_connect ;;
                history) start_history ;;
                *) log_error "Unknown service: $target"; usage; exit 1 ;;
            esac
            echo ""
            print_status
            ;;
        stop)
            case "$target" in
                all)     stop_thriftserver; stop_connect; stop_history; stop_worker; stop_master ;;
                master)  stop_master ;;
                worker)  stop_worker ;;
                thrift)  stop_thriftserver ;;
                connect) stop_connect ;;
                history) stop_history ;;
                *) log_error "Unknown service: $target"; usage; exit 1 ;;
            esac
            ;;
        restart)
            "$0" stop "$target"
            sleep 2
            "$0" start "$target"
            ;;
        status)
            print_status
            ;;
        test)
            test_connections
            ;;
        logs)
            show_logs "${2:-master}" "${3:-100}"
            ;;
        config)
            install_spark_conf
            ;;
        help|--help|-h)
            usage
            ;;
        *)
            log_error "Unknown command: $cmd"
            usage
            exit 1
            ;;
    esac
}

main "$@"
