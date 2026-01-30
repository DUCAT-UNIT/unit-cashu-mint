#!/bin/bash
# Send AWS credentials to enclave via vsock
#
# This script retrieves credentials from EC2 instance metadata (IMDSv2)
# and sends them to the enclave for KMS operations.
# Retries sending since the enclave may not be listening yet.
#
# Usage:
#   ./send-credentials.sh

set -euo pipefail

ENCLAVE_CID="${ENCLAVE_CID:-16}"
CREDS_PORT="${CREDS_PORT:-9000}"
MAX_RETRIES="${MAX_RETRIES:-12}"
RETRY_INTERVAL="${RETRY_INTERVAL:-5}"

log_info() {
    echo "[send-creds] [INFO] $*"
}

log_error() {
    echo "[send-creds] [ERROR] $*" >&2
}

# Get IMDSv2 token
get_imds_token() {
    curl -sX PUT "http://169.254.169.254/latest/api/token" \
        -H "X-aws-ec2-metadata-token-ttl-seconds: 21600"
}

# Get credentials from instance metadata
get_credentials() {
    local token="$1"

    # Get the IAM role name
    local role_name
    role_name=$(curl -s -H "X-aws-ec2-metadata-token: $token" \
        "http://169.254.169.254/latest/meta-data/iam/security-credentials/")

    if [[ -z "$role_name" ]]; then
        log_error "No IAM role attached to instance"
        return 1
    fi

    # Get credentials for the role
    local creds
    creds=$(curl -s -H "X-aws-ec2-metadata-token: $token" \
        "http://169.254.169.254/latest/meta-data/iam/security-credentials/$role_name")

    if [[ -z "$creds" ]]; then
        log_error "Failed to get credentials for role $role_name"
        return 1
    fi

    # Format for enclave
    echo "$creds" | jq '{
        access_key_id: .AccessKeyId,
        secret_access_key: .SecretAccessKey,
        session_token: .Token
    }'
}

# Main
log_info "Starting credential sender..."

# Get IMDS token
TOKEN=$(get_imds_token)
if [[ -z "$TOKEN" ]]; then
    log_error "Failed to get IMDSv2 token"
    exit 1
fi

# Get credentials
CREDS=$(get_credentials "$TOKEN")
if [[ -z "$CREDS" ]]; then
    log_error "Failed to get credentials"
    exit 1
fi

# Send with retries
log_info "Sending credentials to enclave (CID $ENCLAVE_CID, port $CREDS_PORT)..."

for attempt in $(seq 1 $MAX_RETRIES); do
    if echo "$CREDS" | socat - VSOCK-CONNECT:${ENCLAVE_CID}:${CREDS_PORT} 2>/dev/null; then
        log_info "Credentials sent successfully (attempt $attempt)"
        exit 0
    fi
    log_info "Attempt $attempt/$MAX_RETRIES failed, retrying in ${RETRY_INTERVAL}s..."
    sleep "$RETRY_INTERVAL"
done

log_error "Failed to send credentials after $MAX_RETRIES attempts"
exit 1
