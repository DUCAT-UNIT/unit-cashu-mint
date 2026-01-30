#!/bin/bash
# Nitro Enclave Entrypoint Script
# Orchestrates the boot sequence for the Ducat Cashu Mint inside AWS Nitro Enclave
#
# Boot sequence:
# 1. Setup loopback and vsock adapters
# 2. Unseal secrets via KMS attestation
# 3. Start Nginx for TLS termination
# 4. Start Node.js mint server
#
# Security model:
# - TLS terminated inside enclave (parent sees only encrypted bytes)
# - Secrets unsealed via KMS with PCR attestation
# - Parent cannot access plaintext HTTP or private keys

set -euo pipefail

# Configuration
PARENT_CID="${PARENT_CID:-3}"
MINT_PORT="${PORT:-3338}"
HTTPS_PORT="${HTTPS_PORT:-8443}"

# Logging functions
log_info() {
    echo "[enclave] [INFO] $*"
}

log_error() {
    echo "[enclave] [ERROR] $*" >&2
}

log_debug() {
    echo "[enclave] [DEBUG] $*"
}

# Trap for cleanup on exit
cleanup() {
    log_info "Shutting down enclave..."
    pkill -f nginx || true
    pkill -f socat || true
    pkill -f node || true
}
trap cleanup EXIT INT TERM

# ============================================================================
# Step 1: Setup loopback interface
# ============================================================================
log_info "Enclave starting..."
log_debug "PARENT_CID: ${PARENT_CID}"

log_info "Setting up loopback interface..."
ip link set lo up || ifconfig lo up || {
    log_error "Failed to bring up loopback interface"
    echo "1" > /proc/sys/net/ipv4/conf/all/accept_local 2>/dev/null || true
}
ip addr show lo 2>/dev/null || ifconfig lo 2>/dev/null || log_debug "Cannot show loopback"

log_debug "Checking if /dev/vsock exists..."
if [[ -e /dev/vsock ]]; then
    log_info "/dev/vsock exists"
else
    log_error "/dev/vsock does NOT exist!"
fi

# ============================================================================
# Step 2: Start vsock adapters
# ============================================================================
log_info "Starting vsock adapters..."

# PostgreSQL: enclave localhost:5432 -> parent vsock:5432 -> parent postgres
socat TCP-LISTEN:5432,bind=127.0.0.1,fork,reuseaddr VSOCK-CONNECT:${PARENT_CID}:5432 2>&1 &
log_info "PostgreSQL vsock adapter started"

# KMS API: kmstool-enclave-cli uses vsock directly to reach the parent's vsock-proxy
# on port 8000, which forwards to kms.<region>.amazonaws.com:443.
# No TCP-to-vsock adapter needed here - the SDK handles vsock natively.
log_info "KMS access via kmstool-enclave-cli vsock (proxy port 8000)"

# NOTE: External HTTPS APIs (Ord, Esplora, Mempool) require an HTTP proxy on the parent
# because the enclave cannot resolve DNS. Options:
# 1. Run tinyproxy on parent and configure NODE_EXTRA_CA_CERTS + HTTPS_PROXY
# 2. Run a sidecar API service on parent that proxies requests
# 3. Use the parent's vsock-proxy for specific pre-resolved IPs (not recommended)
# For now, external API calls will fail - implement option 1 or 2 for production.

# Inbound HTTPS: parent vsock:${HTTPS_PORT} -> enclave nginx:${HTTPS_PORT}
# This allows parent to forward raw TCP (encrypted TLS) to the enclave
socat VSOCK-LISTEN:${HTTPS_PORT},fork TCP:127.0.0.1:${HTTPS_PORT} 2>&1 &
log_info "Inbound HTTPS vsock listener started on port ${HTTPS_PORT}"

sleep 2

# Verify PostgreSQL connectivity
log_info "Checking PostgreSQL connectivity..."
RETRY_COUNT=0
MAX_RETRIES=10
while ! timeout 2 bash -c "echo > /dev/tcp/127.0.0.1/5432" 2>/dev/null; do
    RETRY_COUNT=$((RETRY_COUNT + 1))
    if [[ $RETRY_COUNT -ge $MAX_RETRIES ]]; then
        log_error "PostgreSQL not reachable via vsock after $MAX_RETRIES attempts"
        log_info "Continuing anyway..."
        break
    fi
    log_info "Waiting for PostgreSQL connectivity... ($RETRY_COUNT/$MAX_RETRIES)"
    sleep 1
done

if [[ $RETRY_COUNT -lt $MAX_RETRIES ]]; then
    log_info "PostgreSQL vsock connection established"
fi

# ============================================================================
# Step 3: Unseal secrets via KMS attestation
# ============================================================================
log_info "Unsealing secrets..."

# Check for KMS key - if not set, fall back to dev mode
KMS_KEY_ID="${KMS_KEY_ID:-}"
FIRST_BOOT="${FIRST_BOOT:-false}"

if [[ -n "$KMS_KEY_ID" ]]; then
    log_info "KMS key configured, using attestation-based unsealing"

    # Source the unsealing script (it exports MINT_SEED and ENCRYPTION_KEY)
    source /app/unseal-secrets.sh

    if [[ -z "${MINT_SEED:-}" ]] || [[ -z "${ENCRYPTION_KEY:-}" ]]; then
        log_error "Failed to unseal secrets from KMS"
        exit 1
    fi
    log_info "Secrets unsealed successfully via KMS attestation"
else
    log_info "KMS not configured - using development mode"

    # Development mode: use provided env vars or fixed dev keys
    # Using fixed keys allows decrypting keysets created by the host mint
    if [[ -z "${MINT_SEED:-}" ]]; then
        log_info "Using development MINT_SEED (dev mode only - DO NOT USE IN PRODUCTION)"
        export MINT_SEED="0000000000000000000000000000000000000000000000000000000000000000"
    fi

    if [[ -z "${ENCRYPTION_KEY:-}" ]]; then
        log_info "Using development ENCRYPTION_KEY (dev mode only - DO NOT USE IN PRODUCTION)"
        export ENCRYPTION_KEY="0000000000000000000000000000000000000000000000000000000000000000"
    fi
fi

# ============================================================================
# Step 4: Set up environment variables
# ============================================================================
log_info "Setting up environment..."

export NODE_ENV="production"
export PORT="${MINT_PORT}"
export HOST="127.0.0.1"
export ENCLAVE_MODE="true"

# Database URL - uses localhost which routes through vsock
export DATABASE_URL="${DATABASE_URL:-postgresql://mintuser:4Mdk+N7JcVgrByWJGMCtSzx3b3IsMndJ@127.0.0.1:5432/mintdb}"

# Network configuration
export NETWORK="${NETWORK:-testnet}"
export ESPLORA_URL="${ESPLORA_URL:-https://mempool.space/testnet/api}"
export ORD_URL="${ORD_URL:-https://testnet.ordinals.com}"
export MEMPOOL_URL="${MEMPOOL_URL:-https://mempool.space/testnet/api}"

# JWT secret - derive from MINT_SEED if not provided
export JWT_SECRET="${JWT_SECRET:-$(echo -n "${MINT_SEED}jwt" | openssl dgst -sha256 | cut -d' ' -f2)}"

# Mint pubkey - will be derived from seed by the application
export MINT_PUBKEY="${MINT_PUBKEY:-}"

# Units configuration
export SUPPORTED_UNITS="${SUPPORTED_UNITS:-sat}"
export SUPPORTED_RUNES="${SUPPORTED_RUNES:-840000:3}"

# Rate limiting
export LOG_LEVEL="${LOG_LEVEL:-info}"
export RATE_LIMIT_MAX="${RATE_LIMIT_MAX:-100}"
export RATE_LIMIT_WINDOW="${RATE_LIMIT_WINDOW:-60000}"

# Mint info
export MINT_NAME="${MINT_NAME:-Ducat Cashu Mint}"
export MINT_DESCRIPTION="${MINT_DESCRIPTION:-Secure Cashu mint running in AWS Nitro Enclave}"

# Limits
export MIN_MINT_AMOUNT="${MIN_MINT_AMOUNT:-100}"
export MAX_MINT_AMOUNT="${MAX_MINT_AMOUNT:-100000000}"
export MIN_MELT_AMOUNT="${MIN_MELT_AMOUNT:-100}"
export MAX_MELT_AMOUNT="${MAX_MELT_AMOUNT:-100000000}"
export MINT_CONFIRMATIONS="${MINT_CONFIRMATIONS:-1}"
export MELT_CONFIRMATIONS="${MELT_CONFIRMATIONS:-1}"

# Log configuration (without secrets)
log_info "Configuration:"
log_info "  PORT: ${PORT}"
log_info "  HTTPS_PORT: ${HTTPS_PORT}"
log_info "  NODE_ENV: ${NODE_ENV}"
log_info "  DATABASE_URL: postgresql://mintuser:***@127.0.0.1:5432/mintdb"
log_info "  NETWORK: ${NETWORK}"
log_info "  KMS_KEY_ID: ${KMS_KEY_ID:-not configured}"

# ============================================================================
# Step 5: Setup TLS certificates
# ============================================================================
log_info "Setting up TLS certificates..."

ACM_CERT_ARN="${ACM_CERT_ARN:-}"

if [[ -n "$ACM_CERT_ARN" ]]; then
    log_info "Using ACM for Nitro Enclaves certificate"

    # Start the ACM agent to provision certificate
    /usr/bin/nitro-enclaves-acm &
    ACM_PID=$!

    # Wait for certificate to be provisioned
    CERT_WAIT=0
    while [[ ! -f /run/acm/cert.pem ]] && [[ $CERT_WAIT -lt 30 ]]; do
        sleep 1
        CERT_WAIT=$((CERT_WAIT + 1))
    done

    if [[ -f /run/acm/cert.pem ]]; then
        log_info "ACM certificate provisioned"
    else
        log_error "Failed to provision ACM certificate"
        exit 1
    fi
else
    log_info "ACM not configured - generating self-signed certificate (dev mode)"

    # Generate self-signed cert for development
    mkdir -p /run/acm
    openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
        -keyout /run/acm/key.pem \
        -out /run/acm/cert.pem \
        -subj "/CN=localhost" \
        2>/dev/null

    log_info "Self-signed certificate generated"
fi

# ============================================================================
# Step 6: Configure and start Nginx for TLS termination
# ============================================================================
log_info "Starting Nginx for TLS termination..."

# Check if we're using ACM (PKCS#11) or self-signed (file-based key)
if [[ -n "$ACM_CERT_ARN" ]]; then
    # ACM mode: nginx.conf already configured for PKCS#11
    log_info "Using ACM PKCS#11 for TLS"
else
    # Self-signed mode: update nginx config to use file-based key
    log_info "Using file-based TLS key"
    sed -i 's|ssl_certificate_key engine:pkcs11:pkcs11:token=acm;|ssl_certificate_key /run/acm/key.pem;|' /etc/nginx/nginx.conf
fi

# Test nginx config
nginx -t 2>&1 || {
    log_error "Nginx configuration test failed"
    cat /etc/nginx/nginx.conf
    exit 1
}

# Start nginx
nginx
log_info "Nginx started on port ${HTTPS_PORT}"

# ============================================================================
# Step 7: Start Node.js mint server
# ============================================================================
log_info "Starting Node.js mint server on port ${MINT_PORT}..."

cd /app

# Run node with the compiled JavaScript
exec node dist/server.js
