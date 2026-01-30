#!/bin/bash
# Receive encrypted secrets from enclave via vsock
#
# During first boot, the enclave generates data keys via KMS and sends
# the encrypted ciphertexts to the parent for persistent storage.
# On subsequent boots, the parent sends these back to the enclave
# for attestation-based decryption.
#
# Usage:
#   ./receive-secrets.sh                          # Listen and save to default path
#   ./receive-secrets.sh /path/to/save/secrets.json  # Custom save path

set -euo pipefail

SECRETS_FILE="${1:-/opt/mint-enclave/secrets/encrypted_secrets.json}"
RECEIVE_PORT="${RECEIVE_PORT:-9001}"

log_info() {
    echo "[recv-secrets] [INFO] $*"
}

log_error() {
    echo "[recv-secrets] [ERROR] $*" >&2
}

# Main
log_info "Listening for encrypted secrets from enclave on vsock port ${RECEIVE_PORT}..."

mkdir -p "$(dirname "$SECRETS_FILE")"

# Listen on vsock for secrets from enclave (timeout 120s to allow for KMS operations)
SECRETS_JSON=$(timeout 120 socat -u VSOCK-LISTEN:${RECEIVE_PORT} - 2>/dev/null) || {
    log_error "Failed to receive secrets from enclave (timeout or connection error)"
    exit 1
}

if [[ -z "$SECRETS_JSON" ]]; then
    log_error "Empty secrets received from enclave"
    exit 1
fi

# Validate JSON
if ! echo "$SECRETS_JSON" | jq . >/dev/null 2>&1; then
    log_error "Invalid JSON received from enclave"
    exit 1
fi

# Check required fields
MINT_SEED_CT=$(echo "$SECRETS_JSON" | jq -r '.MINT_SEED // empty')
ENC_KEY_CT=$(echo "$SECRETS_JSON" | jq -r '.ENCRYPTION_KEY // empty')

if [[ -z "$MINT_SEED_CT" ]] || [[ -z "$ENC_KEY_CT" ]]; then
    log_error "Missing required fields in secrets JSON"
    exit 1
fi

# Save to file
echo "$SECRETS_JSON" > "$SECRETS_FILE"
chmod 600 "$SECRETS_FILE"

log_info "Encrypted secrets saved to: $SECRETS_FILE"
log_info "MINT_SEED ciphertext length: ${#MINT_SEED_CT}"
log_info "ENCRYPTION_KEY ciphertext length: ${#ENC_KEY_CT}"
log_info "These secrets can only be decrypted inside an enclave with matching PCR0"
