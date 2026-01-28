#!/bin/bash
# Nitro Enclave Entrypoint Script
# Orchestrates the boot sequence for the Ducat Cashu Mint inside AWS Nitro Enclave
#
# Boot sequence:
# 1. Start vsock adapters (enables TCP over vsock to parent services)
# 2. Wait for vsock connectivity
# 3. Unseal secrets via KMS attestation
# 4. Start Node.js mint server
# 5. Start Nginx for TLS termination
#
# Environment:
# - VSOCK_CID: Parent CID (default: 3)
# - KMS_KEY_ID: KMS key ARN for secret unsealing
# - FIRST_BOOT: Set to "true" to generate new secrets

set -euo pipefail

# Configuration
VSOCK_CID="${VSOCK_CID:-3}"
MINT_PORT="${MINT_PORT:-3338}"
LOG_LEVEL="${LOG_LEVEL:-info}"

# Logging functions
log_info() {
    echo "[$(date -Iseconds)] [INFO] $*"
}

log_error() {
    echo "[$(date -Iseconds)] [ERROR] $*" >&2
}

log_debug() {
    if [[ "${LOG_LEVEL}" == "debug" ]]; then
        echo "[$(date -Iseconds)] [DEBUG] $*"
    fi
}

# Trap for cleanup on exit
cleanup() {
    log_info "Shutting down enclave services..."

    # Stop Node.js gracefully
    if [[ -n "${NODE_PID:-}" ]]; then
        kill -TERM "$NODE_PID" 2>/dev/null || true
        wait "$NODE_PID" 2>/dev/null || true
    fi

    # Stop vsock adapters
    pkill -f vsock-adapter || true

    log_info "Enclave shutdown complete"
}
trap cleanup EXIT INT TERM

# ============================================================================
# Step 1: Start vsock adapters
# These create localhost listeners that forward traffic to parent via vsock
# ============================================================================
log_info "Starting vsock adapters..."

# PostgreSQL: localhost:5432 -> vsock:5432
/app/vsock-adapter.sh "$VSOCK_CID" 5432 5432 &
VSOCK_PG_PID=$!
log_debug "PostgreSQL vsock adapter started (PID: $VSOCK_PG_PID)"

# Redis: localhost:6379 -> vsock:6379
/app/vsock-adapter.sh "$VSOCK_CID" 6379 6379 &
VSOCK_REDIS_PID=$!
log_debug "Redis vsock adapter started (PID: $VSOCK_REDIS_PID)"

# KMS: localhost:8443 -> vsock:443 (for KMS API calls)
/app/vsock-adapter.sh "$VSOCK_CID" 443 8443 &
VSOCK_KMS_PID=$!
log_debug "KMS vsock adapter started (PID: $VSOCK_KMS_PID)"

# Ord/Esplora: localhost:8332 -> vsock:8332
/app/vsock-adapter.sh "$VSOCK_CID" 8332 8332 &
VSOCK_ORD_PID=$!
log_debug "Ord vsock adapter started (PID: $VSOCK_ORD_PID)"

# Esplora: localhost:8333 -> vsock:8333
/app/vsock-adapter.sh "$VSOCK_CID" 8333 8333 &
VSOCK_ESPLORA_PID=$!
log_debug "Esplora vsock adapter started (PID: $VSOCK_ESPLORA_PID)"

# Mempool: localhost:8334 -> vsock:8334
/app/vsock-adapter.sh "$VSOCK_CID" 8334 8334 &
VSOCK_MEMPOOL_PID=$!
log_debug "Mempool vsock adapter started (PID: $VSOCK_MEMPOOL_PID)"

# ============================================================================
# Step 2: Wait for vsock connectivity
# ============================================================================
log_info "Waiting for vsock connectivity..."

# Wait for PostgreSQL to be reachable
RETRY_COUNT=0
MAX_RETRIES=30
until nc -z localhost 5432 2>/dev/null; do
    RETRY_COUNT=$((RETRY_COUNT + 1))
    if [[ $RETRY_COUNT -ge $MAX_RETRIES ]]; then
        log_error "PostgreSQL not reachable after $MAX_RETRIES attempts"
        exit 1
    fi
    log_debug "Waiting for PostgreSQL... ($RETRY_COUNT/$MAX_RETRIES)"
    sleep 1
done
log_info "PostgreSQL connection established"

# ============================================================================
# Step 3: Unseal secrets via KMS attestation
# ============================================================================
log_info "Unsealing secrets via KMS attestation..."

# Source the unseal script which sets environment variables
# On first boot, generates new secrets and seals them
# On subsequent boots, retrieves and decrypts existing secrets
source /app/unseal-secrets.sh

if [[ -z "${MINT_SEED:-}" ]] || [[ -z "${ENCRYPTION_KEY:-}" ]]; then
    log_error "Failed to unseal secrets - MINT_SEED or ENCRYPTION_KEY not set"
    exit 1
fi

log_info "Secrets unsealed successfully"

# ============================================================================
# Step 4: Initialize ACM certificate (for TLS termination)
# ============================================================================
log_info "Initializing ACM certificate..."

# ACM for Nitro Enclaves automatically fetches certificate
# The certificate is stored in /run/acm/ and private key accessible via PKCS#11
if [[ -f /etc/nitro_enclaves/acm.yaml ]]; then
    nitro-cli acm &
    sleep 2

    if [[ -f /run/acm/cert.pem ]]; then
        log_info "ACM certificate loaded successfully"
    else
        log_error "ACM certificate not found at /run/acm/cert.pem"
        # Continue without TLS for development/testing
        log_info "Continuing without ACM certificate (development mode)"
    fi
else
    log_info "ACM configuration not found - running without TLS (development mode)"
fi

# ============================================================================
# Step 5: Prepare environment file for Node.js
# ============================================================================
log_info "Preparing environment configuration..."

# Create runtime .env file with unsealed secrets
cat > /app/.env << EOF
# Enclave Runtime Configuration
# Generated at $(date -Iseconds)

NODE_ENV=${NODE_ENV:-production}
PORT=${MINT_PORT}
HOST=127.0.0.1
ENCLAVE_MODE=true

# Database (via vsock)
DATABASE_URL=${DATABASE_URL:-postgresql://mintuser:password@localhost:5432/mintdb}
REDIS_URL=${REDIS_URL:-redis://localhost:6379}

# Bitcoin network
NETWORK=${NETWORK:-mainnet}
ESPLORA_URL=http://localhost:8333
ORD_URL=http://localhost:8332
MEMPOOL_URL=http://localhost:8334

# Unsealed secrets
MINT_SEED=${MINT_SEED}
ENCRYPTION_KEY=${ENCRYPTION_KEY}
JWT_SECRET=${JWT_SECRET:-$(openssl rand -hex 32)}

# Mint configuration
MINT_PUBKEY=${MINT_PUBKEY:-}
MINT_TAPROOT_ADDRESS=${MINT_TAPROOT_ADDRESS:-}
MINT_TAPROOT_PUBKEY=${MINT_TAPROOT_PUBKEY:-}
MINT_SEGWIT_ADDRESS=${MINT_SEGWIT_ADDRESS:-}
SUPPORTED_RUNES=${SUPPORTED_RUNES:-}
SUPPORTED_UNITS=${SUPPORTED_UNITS:-sat}
MINT_BTC_ADDRESS=${MINT_BTC_ADDRESS:-}
MINT_BTC_PUBKEY=${MINT_BTC_PUBKEY:-}
BTC_FEE_RATE=${BTC_FEE_RATE:-5}

# Logging
LOG_LEVEL=${LOG_LEVEL}

# Rate limiting
RATE_LIMIT_MAX=${RATE_LIMIT_MAX:-100}
RATE_LIMIT_WINDOW=${RATE_LIMIT_WINDOW:-60000}

# Mint info
MINT_NAME=${MINT_NAME:-Ducat Cashu Mint}
MINT_DESCRIPTION=${MINT_DESCRIPTION:-Secure Cashu mint running in AWS Nitro Enclave}

# Amount limits
MIN_MINT_AMOUNT=${MIN_MINT_AMOUNT:-100}
MAX_MINT_AMOUNT=${MAX_MINT_AMOUNT:-100000000}
MIN_MELT_AMOUNT=${MIN_MELT_AMOUNT:-100}
MAX_MELT_AMOUNT=${MAX_MELT_AMOUNT:-100000000}

# Confirmations
MINT_CONFIRMATIONS=${MINT_CONFIRMATIONS:-1}
MELT_CONFIRMATIONS=${MELT_CONFIRMATIONS:-1}
EOF

chmod 600 /app/.env
log_debug "Environment file created at /app/.env"

# ============================================================================
# Step 6: Start Node.js mint server
# ============================================================================
log_info "Starting Node.js mint server on port ${MINT_PORT}..."

cd /app
node dist/server.js &
NODE_PID=$!

# Wait for Node.js to be ready
RETRY_COUNT=0
MAX_RETRIES=30
until curl -sf http://127.0.0.1:${MINT_PORT}/health > /dev/null 2>&1; do
    RETRY_COUNT=$((RETRY_COUNT + 1))
    if [[ $RETRY_COUNT -ge $MAX_RETRIES ]]; then
        log_error "Node.js server failed to start after $MAX_RETRIES attempts"
        exit 1
    fi

    # Check if process is still running
    if ! kill -0 "$NODE_PID" 2>/dev/null; then
        log_error "Node.js process died unexpectedly"
        exit 1
    fi

    log_debug "Waiting for Node.js server... ($RETRY_COUNT/$MAX_RETRIES)"
    sleep 1
done

log_info "Node.js mint server started successfully (PID: $NODE_PID)"

# ============================================================================
# Step 7: Start Nginx for TLS termination
# ============================================================================
log_info "Starting Nginx for TLS termination..."

# Test Nginx configuration
nginx -t 2>/dev/null || {
    log_error "Nginx configuration test failed"
    nginx -t
    exit 1
}

# Start Nginx in foreground (keeps entrypoint running)
log_info "Enclave boot complete - all services running"
log_info "  - Node.js mint: http://127.0.0.1:${MINT_PORT}"
log_info "  - Nginx TLS: vsock:8443"
log_info "  - PostgreSQL: localhost:5432 (via vsock)"
log_info "  - Redis: localhost:6379 (via vsock)"

# Run Nginx in foreground
exec nginx -g 'daemon off;'
