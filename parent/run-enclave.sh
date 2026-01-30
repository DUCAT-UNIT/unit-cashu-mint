#!/bin/bash
# Run the Ducat Mint Enclave
#
# Usage:
#   ./run-enclave.sh                    # Normal boot (unseal existing secrets)
#   ./run-enclave.sh --first-boot       # First boot (generate and seal new secrets)
#   ./run-enclave.sh --debug            # Run with debug console
#
# Prerequisites:
#   1. EIF built: ./enclave/build.sh
#   2. Proxies set up: ./parent/setup-proxies.sh
#   3. KMS key created: ./parent/setup-kms.sh

set -euo pipefail

# Configuration
ENCLAVE_CID="${ENCLAVE_CID:-16}"
ENCLAVE_MEMORY="${ENCLAVE_MEMORY:-4096}"
ENCLAVE_CPU="${ENCLAVE_CPU:-2}"
EIF_PATH="${EIF_PATH:-/opt/enclave/mint-enclave.eif}"
SECRETS_PATH="${SECRETS_PATH:-/opt/enclave/secrets}"

DEBUG_MODE=""
FIRST_BOOT=""

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --debug)
            DEBUG_MODE="--debug-mode"
            shift
            ;;
        --first-boot)
            FIRST_BOOT="true"
            shift
            ;;
        *)
            echo "Unknown option: $1"
            echo "Usage: $0 [--debug] [--first-boot]"
            exit 1
            ;;
    esac
done

log_info() {
    echo "[run-enclave] [INFO] $*"
}

log_error() {
    echo "[run-enclave] [ERROR] $*" >&2
}

# Check prerequisites
log_info "Checking prerequisites..."

if [[ ! -f "$EIF_PATH" ]]; then
    log_error "EIF not found at $EIF_PATH"
    log_error "Build it first: ./enclave/build.sh"
    exit 1
fi

# Check if enclave is already running
EXISTING_ENCLAVE=$(nitro-cli describe-enclaves | jq -r '.[0].EnclaveCID // empty')
if [[ -n "$EXISTING_ENCLAVE" ]]; then
    log_info "Terminating existing enclave (CID: $EXISTING_ENCLAVE)..."
    nitro-cli terminate-enclave --enclave-id $(nitro-cli describe-enclaves | jq -r '.[0].EnclaveID')
    sleep 2
fi

# Create secrets directory if it doesn't exist
mkdir -p "$SECRETS_PATH"

# Check for encrypted secrets file (unless first boot)
ENCRYPTED_SECRETS="${SECRETS_PATH}/encrypted_secrets.json"
if [[ "$FIRST_BOOT" != "true" ]] && [[ ! -f "$ENCRYPTED_SECRETS" ]]; then
    log_error "Encrypted secrets not found at $ENCRYPTED_SECRETS"
    log_error "Run with --first-boot to generate new secrets"
    exit 1
fi

# Ensure proxy services are running
log_info "Checking proxy services..."

for service in mint-postgres-proxy mint-kms-proxy; do
    if ! systemctl is-active --quiet "$service"; then
        log_info "Starting $service..."
        sudo systemctl start "$service"
    fi
done

# Run the enclave
log_info "Starting enclave..."
log_info "  CID: $ENCLAVE_CID"
log_info "  Memory: ${ENCLAVE_MEMORY}MB"
log_info "  CPUs: $ENCLAVE_CPU"
log_info "  First boot: ${FIRST_BOOT:-false}"

# Build the run command
RUN_CMD="nitro-cli run-enclave \
    --enclave-cid $ENCLAVE_CID \
    --eif-path $EIF_PATH \
    --memory $ENCLAVE_MEMORY \
    --cpu-count $ENCLAVE_CPU"

if [[ -n "$DEBUG_MODE" ]]; then
    RUN_CMD="$RUN_CMD --debug-mode"
fi

# Run the enclave
eval "$RUN_CMD"

# Wait for enclave to start
sleep 3

# Get enclave ID
ENCLAVE_ID=$(nitro-cli describe-enclaves | jq -r '.[0].EnclaveID')
log_info "Enclave started: $ENCLAVE_ID"

# If first boot, we need to handle secret generation
if [[ "$FIRST_BOOT" == "true" ]]; then
    log_info "First boot - enclave is generating and sealing secrets..."
    log_info "Monitor with: nitro-cli console --enclave-id $ENCLAVE_ID"
    log_info ""
    log_info "After secrets are generated, copy them from enclave:"
    log_info "  The encrypted_secrets.json file will be in /run/secrets/ inside the enclave"
    log_info "  You'll need to extract it and save to $ENCRYPTED_SECRETS"
fi

# Start the inbound HTTPS proxy
log_info "Starting inbound HTTPS proxy..."
sudo systemctl start mint-inbound.service

# Show status
echo ""
echo "=== Enclave Status ==="
nitro-cli describe-enclaves | jq .

echo ""
echo "=== Proxy Status ==="
systemctl status mint-inbound.service --no-pager || true

echo ""
log_info "Enclave is running!"
echo ""
echo "Test the mint:"
echo "  curl -k https://localhost/health"
echo "  curl -k https://localhost/v1/info"
echo ""
echo "View enclave console (debug mode only):"
echo "  nitro-cli console --enclave-id $ENCLAVE_ID"
echo ""
echo "Stop enclave:"
echo "  nitro-cli terminate-enclave --enclave-id $ENCLAVE_ID"
