#!/bin/bash
# vsock Adapter Script
# Forwards localhost TCP connections to parent instance via vsock
#
# Usage: vsock-adapter.sh <parent_cid> <vsock_port> <local_port>
#
# This creates a localhost listener that forwards all traffic to the parent
# instance through vsock. This allows applications inside the enclave to use
# standard TCP connections (e.g., PostgreSQL, Redis) without code changes.
#
# Example:
#   vsock-adapter.sh 3 5432 5432
#   # Creates: localhost:5432 -> vsock(CID=3):5432 -> parent localhost:5432

set -euo pipefail

PARENT_CID="${1:-3}"
VSOCK_PORT="${2:-5432}"
LOCAL_PORT="${3:-$VSOCK_PORT}"

LOG_PREFIX="[vsock-adapter:${LOCAL_PORT}]"

log_info() {
    echo "$LOG_PREFIX [INFO] $*"
}

log_error() {
    echo "$LOG_PREFIX [ERROR] $*" >&2
}

log_debug() {
    if [[ "${LOG_LEVEL:-info}" == "debug" ]]; then
        echo "$LOG_PREFIX [DEBUG] $*"
    fi
}

# Check if socat is available
if ! command -v socat &> /dev/null; then
    log_error "socat is not installed"
    exit 1
fi

log_info "Starting vsock adapter: localhost:${LOCAL_PORT} -> vsock(CID=${PARENT_CID}):${VSOCK_PORT}"

# Use socat to create the bridge
# VSOCK-CONNECT connects to the parent's vsock-proxy listener
# TCP-LISTEN creates a localhost listener inside the enclave
exec socat \
    TCP-LISTEN:${LOCAL_PORT},bind=127.0.0.1,fork,reuseaddr \
    VSOCK-CONNECT:${PARENT_CID}:${VSOCK_PORT}
