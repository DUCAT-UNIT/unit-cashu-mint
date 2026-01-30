#!/bin/bash
# Send encrypted secrets to enclave via vsock
#
# This script sends the encrypted secrets file to the enclave on boot.
# The enclave can then decrypt them using KMS with attestation.
# Retries sending since the enclave may not be listening yet.
#
# Usage:
#   ./send-secrets.sh                              # Send default secrets file
#   ./send-secrets.sh /path/to/encrypted_secrets.json  # Send custom file

set -euo pipefail

ENCLAVE_CID="${ENCLAVE_CID:-16}"
SECRETS_PORT="${SECRETS_PORT:-9002}"
SECRETS_FILE="${1:-/opt/mint-enclave/secrets/encrypted_secrets.json}"
MAX_RETRIES="${MAX_RETRIES:-12}"
RETRY_INTERVAL="${RETRY_INTERVAL:-5}"

log_info() {
    echo "[send-secrets] [INFO] $*"
}

log_error() {
    echo "[send-secrets] [ERROR] $*" >&2
}

# Main
log_info "Sending encrypted secrets to enclave..."

if [[ ! -f "$SECRETS_FILE" ]]; then
    log_error "Secrets file not found: $SECRETS_FILE"
    log_error "Run first boot to generate secrets, then save them to this location"
    exit 1
fi

log_info "Secrets file: $SECRETS_FILE"
log_info "Target: CID $ENCLAVE_CID, port $SECRETS_PORT"

for attempt in $(seq 1 $MAX_RETRIES); do
    if cat "$SECRETS_FILE" | socat - VSOCK-CONNECT:${ENCLAVE_CID}:${SECRETS_PORT} 2>/dev/null; then
        log_info "Encrypted secrets sent successfully (attempt $attempt)"
        exit 0
    fi
    log_info "Attempt $attempt/$MAX_RETRIES failed, retrying in ${RETRY_INTERVAL}s..."
    sleep "$RETRY_INTERVAL"
done

log_error "Failed to send secrets after $MAX_RETRIES attempts"
exit 1
