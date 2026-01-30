#!/bin/bash
# KMS Secrets Unsealing Script for Nitro Enclave
#
# This script handles the secure generation and retrieval of cryptographic secrets
# using AWS KMS with Nitro Enclave attestation via kmstool-enclave-cli.
#
# Modes:
# 1. FIRST_BOOT=true: Generate data keys via KMS genkey, store encrypted ciphertext
# 2. Normal boot: Retrieve ciphertext, decrypt via KMS attestation
#
# Secrets managed:
# - MINT_SEED: 32-byte seed for deterministic key derivation (from KMS genkey)
# - ENCRYPTION_KEY: 32-byte key for encrypting private keys in database (from KMS genkey)
#
# kmstool-enclave-cli commands used:
# - genkey: Generate a data key (returns plaintext + ciphertext). Used for first boot.
# - decrypt: Decrypt ciphertext using attestation. Used for normal boot.
#
# Note: kmstool-enclave-cli connects to KMS through a vsock proxy on the parent (CID 3).
#       The parent must run: vsock-proxy 8000 kms.<region>.amazonaws.com 443
#       Credentials are passed as CLI arguments, not environment variables.
#
# Credential flow:
# 1. Parent retrieves credentials from instance metadata (IMDSv2)
# 2. Parent sends credentials to enclave via vsock (port 9000)
# 3. Enclave uses kmstool-enclave-cli with attestation to call KMS via proxy

set -euo pipefail

# Configuration
KMS_KEY_ID="${KMS_KEY_ID:-}"
AWS_REGION="${AWS_REGION:-us-east-1}"
SECRETS_FILE="${SECRETS_FILE:-/run/secrets/encrypted_secrets.json}"
CREDS_PORT="${CREDS_PORT:-9000}"
FIRST_BOOT="${FIRST_BOOT:-false}"
PARENT_CID="${PARENT_CID:-3}"
KMS_PROXY_PORT="${KMS_PROXY_PORT:-8000}"

# Credential variables (populated by read_credentials_from_parent)
CRED_ACCESS_KEY=""
CRED_SECRET_KEY=""
CRED_SESSION_TOKEN=""

log_info() {
    echo "[unseal] [INFO] $*"
}

log_error() {
    echo "[unseal] [ERROR] $*" >&2
}

log_debug() {
    if [[ "${LOG_LEVEL:-info}" == "debug" ]]; then
        echo "[unseal] [DEBUG] $*"
    fi
}

# Check if running inside Nitro Enclave
is_enclave() {
    [[ -c "/dev/nsm" ]]
}

# Read credentials from parent via vsock
# The parent should send JSON with AWS credentials
read_credentials_from_parent() {
    log_info "Waiting for credentials from parent on vsock port ${CREDS_PORT}..."

    local creds_json

    # Listen on vsock for credentials from parent
    # Parent sends: {"access_key_id": "...", "secret_access_key": "...", "session_token": "..."}
    creds_json=$(timeout 120 socat -u VSOCK-LISTEN:${CREDS_PORT} - 2>/dev/null) || {
        log_error "Failed to receive credentials from parent (timeout or connection error)"
        return 1
    }

    if [[ -z "$creds_json" ]]; then
        log_error "Empty credentials received from parent"
        return 1
    fi

    # Parse credentials into module-level variables
    CRED_ACCESS_KEY=$(echo "$creds_json" | jq -r '.access_key_id // .AccessKeyId // empty')
    CRED_SECRET_KEY=$(echo "$creds_json" | jq -r '.secret_access_key // .SecretAccessKey // empty')
    CRED_SESSION_TOKEN=$(echo "$creds_json" | jq -r '.session_token // .Token // empty')

    if [[ -z "$CRED_ACCESS_KEY" ]] || [[ -z "$CRED_SECRET_KEY" ]]; then
        log_error "Invalid credentials format"
        return 1
    fi

    log_info "Credentials received from parent"
    return 0
}

# Generate a data key using KMS genkey command
# Returns JSON with both plaintext and ciphertext
# The plaintext is the raw key, the ciphertext is the KMS-encrypted version
kms_genkey() {
    log_info "Generating data key via KMS..."

    local result
    result=$(kmstool-enclave-cli genkey \
        --region "$AWS_REGION" \
        --proxy-port "$KMS_PROXY_PORT" \
        --aws-access-key-id "$CRED_ACCESS_KEY" \
        --aws-secret-access-key "$CRED_SECRET_KEY" \
        --aws-session-token "$CRED_SESSION_TOKEN" \
        --key-id "$KMS_KEY_ID" \
        --key-spec "AES-256" 2>&1) || {
        log_error "kmstool-enclave-cli genkey failed: $result"
        return 1
    }

    echo "$result"
}

# Decrypt ciphertext using kmstool-enclave-cli with attestation
# KMS validates the attestation document before decrypting
kms_decrypt() {
    local ciphertext_b64="$1"

    log_debug "Decrypting with KMS attestation..."

    local result
    result=$(kmstool-enclave-cli decrypt \
        --region "$AWS_REGION" \
        --proxy-port "$KMS_PROXY_PORT" \
        --aws-access-key-id "$CRED_ACCESS_KEY" \
        --aws-secret-access-key "$CRED_SECRET_KEY" \
        --aws-session-token "$CRED_SESSION_TOKEN" \
        --ciphertext "$ciphertext_b64" 2>&1) || {
        log_error "kmstool-enclave-cli decrypt failed: $result"
        return 1
    }

    # Result is base64-encoded plaintext
    echo "$result"
}

# Read encrypted secrets from file
read_encrypted_secrets() {
    if [[ ! -f "$SECRETS_FILE" ]]; then
        log_error "Encrypted secrets file not found: $SECRETS_FILE"
        return 1
    fi

    cat "$SECRETS_FILE"
}

# Write encrypted secrets to file
write_encrypted_secrets() {
    local secrets_json="$1"

    mkdir -p "$(dirname "$SECRETS_FILE")"
    echo "$secrets_json" > "$SECRETS_FILE"
    chmod 600 "$SECRETS_FILE"
}

# ============================================================================
# Main unsealing logic
# ============================================================================

log_info "Starting secrets unsealing process..."

# Check for KMS key ID
if [[ -z "$KMS_KEY_ID" ]]; then
    log_info "KMS_KEY_ID not set - using development mode"

    # Development mode: use environment variables directly if set
    if [[ -n "${MINT_SEED:-}" ]] && [[ -n "${ENCRYPTION_KEY:-}" ]]; then
        log_info "Using pre-configured secrets (development mode)"
        export MINT_SEED
        export ENCRYPTION_KEY
        return 0 2>/dev/null || exit 0
    fi

    # Generate dev secrets if not provided
    log_info "Using development MINT_SEED (dev mode only - DO NOT USE IN PRODUCTION)"
    export MINT_SEED="0000000000000000000000000000000000000000000000000000000000000000"
    log_info "Using development ENCRYPTION_KEY (dev mode only - DO NOT USE IN PRODUCTION)"
    export ENCRYPTION_KEY="0000000000000000000000000000000000000000000000000000000000000000"
    return 0 2>/dev/null || exit 0
fi

# Production mode - need KMS and credentials
log_info "Production mode: using KMS key $KMS_KEY_ID"

# Check if we're in an enclave
if ! is_enclave; then
    log_error "Not running inside Nitro Enclave (/dev/nsm not found)"
    log_error "Cannot use KMS attestation outside of enclave"
    exit 1
fi

# Get credentials from parent
if ! read_credentials_from_parent; then
    log_error "Failed to get credentials from parent"
    log_error "Ensure parent is running send-credentials.sh"
    exit 1
fi

if [[ "$FIRST_BOOT" == "true" ]]; then
    # ========================================================================
    # First Boot: Generate data keys via KMS
    # ========================================================================
    log_info "First boot detected - generating new secrets via KMS genkey..."

    # Generate MINT_SEED data key
    log_info "Generating MINT_SEED data key..."
    MINT_SEED_RESULT=$(kms_genkey)
    if [[ -z "$MINT_SEED_RESULT" ]]; then
        log_error "Failed to generate MINT_SEED data key"
        exit 1
    fi

    # Parse genkey output - it returns PLAINTEXT: <b64> and CIPHERTEXT: <b64>
    # The exact format depends on the tool version, try to extract both
    MINT_SEED_PLAINTEXT_B64=$(echo "$MINT_SEED_RESULT" | grep -i "PLAINTEXT" | sed 's/.*: *//')
    MINT_SEED_CIPHERTEXT_B64=$(echo "$MINT_SEED_RESULT" | grep -i "CIPHERTEXT" | sed 's/.*: *//')

    if [[ -z "$MINT_SEED_PLAINTEXT_B64" ]] || [[ -z "$MINT_SEED_CIPHERTEXT_B64" ]]; then
        log_error "Failed to parse genkey output for MINT_SEED"
        log_error "Raw output: $MINT_SEED_RESULT"
        exit 1
    fi

    # Convert plaintext from base64 to hex (32 bytes = 64 hex chars)
    MINT_SEED=$(echo -n "$MINT_SEED_PLAINTEXT_B64" | base64 -d | od -A n -t x1 | tr -d ' \n')

    log_info "MINT_SEED generated and encrypted"

    # Generate ENCRYPTION_KEY data key
    log_info "Generating ENCRYPTION_KEY data key..."
    ENC_KEY_RESULT=$(kms_genkey)
    if [[ -z "$ENC_KEY_RESULT" ]]; then
        log_error "Failed to generate ENCRYPTION_KEY data key"
        exit 1
    fi

    ENC_KEY_PLAINTEXT_B64=$(echo "$ENC_KEY_RESULT" | grep -i "PLAINTEXT" | sed 's/.*: *//')
    ENC_KEY_CIPHERTEXT_B64=$(echo "$ENC_KEY_RESULT" | grep -i "CIPHERTEXT" | sed 's/.*: *//')

    if [[ -z "$ENC_KEY_PLAINTEXT_B64" ]] || [[ -z "$ENC_KEY_CIPHERTEXT_B64" ]]; then
        log_error "Failed to parse genkey output for ENCRYPTION_KEY"
        log_error "Raw output: $ENC_KEY_RESULT"
        exit 1
    fi

    ENCRYPTION_KEY=$(echo -n "$ENC_KEY_PLAINTEXT_B64" | base64 -d | od -A n -t x1 | tr -d ' \n')

    log_info "ENCRYPTION_KEY generated and encrypted"

    # Store encrypted ciphertexts (these can only be decrypted with attestation)
    log_info "Storing encrypted secrets..."
    secrets_json=$(jq -n \
        --arg mint_seed "$MINT_SEED_CIPHERTEXT_B64" \
        --arg encryption_key "$ENC_KEY_CIPHERTEXT_B64" \
        '{MINT_SEED: $mint_seed, ENCRYPTION_KEY: $encryption_key}')

    write_encrypted_secrets "$secrets_json"

    log_info "First boot complete - secrets generated and sealed"
    log_info "Encrypted secrets stored at: $SECRETS_FILE"

    # Send encrypted secrets to parent for backup via vsock
    echo "$secrets_json" | socat - VSOCK-CONNECT:${PARENT_CID}:9001 2>/dev/null || {
        log_info "Could not send secrets to parent (port 9001) - manual backup required"
    }

else
    # ========================================================================
    # Normal Boot: Retrieve and unseal existing secrets
    # ========================================================================
    log_info "Retrieving encrypted secrets..."

    # Check if secrets file exists, if not wait for parent to send it
    if [[ ! -f "$SECRETS_FILE" ]]; then
        log_info "Waiting for encrypted secrets from parent..."

        # Ensure directory exists
        mkdir -p "$(dirname "$SECRETS_FILE")"

        # Wait for secrets file from parent via vsock
        timeout 120 socat -u VSOCK-LISTEN:9002 CREATE:"$SECRETS_FILE" 2>/dev/null || {
            log_error "Failed to receive encrypted secrets from parent"
            log_error "Either provide $SECRETS_FILE or run send-secrets.sh on parent"
            exit 1
        }

        if [[ ! -f "$SECRETS_FILE" ]] || [[ ! -s "$SECRETS_FILE" ]]; then
            log_error "Secrets file not received or empty"
            exit 1
        fi
        log_info "Received encrypted secrets from parent"
    fi

    # Read encrypted secrets from file
    secrets_json=$(read_encrypted_secrets)
    if [[ -z "$secrets_json" ]]; then
        log_error "Failed to read encrypted secrets"
        log_error "Run with FIRST_BOOT=true to generate new secrets"
        exit 1
    fi

    MINT_SEED_CIPHERTEXT=$(echo "$secrets_json" | jq -r '.MINT_SEED')
    ENC_KEY_CIPHERTEXT=$(echo "$secrets_json" | jq -r '.ENCRYPTION_KEY')

    if [[ -z "$MINT_SEED_CIPHERTEXT" ]] || [[ "$MINT_SEED_CIPHERTEXT" == "null" ]]; then
        log_error "MINT_SEED not found in secrets file"
        exit 1
    fi

    if [[ -z "$ENC_KEY_CIPHERTEXT" ]] || [[ "$ENC_KEY_CIPHERTEXT" == "null" ]]; then
        log_error "ENCRYPTION_KEY not found in secrets file"
        exit 1
    fi

    # Decrypt secrets using KMS with attestation
    log_info "Decrypting MINT_SEED via KMS attestation..."
    MINT_SEED_RAW=$(kms_decrypt "$MINT_SEED_CIPHERTEXT")
    if [[ -z "$MINT_SEED_RAW" ]]; then
        log_error "Failed to decrypt MINT_SEED"
        log_error "This may indicate PCR0 mismatch - update KMS policy"
        exit 1
    fi
    log_debug "MINT_SEED decrypt raw output: $MINT_SEED_RAW"
    # Extract base64 from PLAINTEXT line if present, otherwise use raw output
    MINT_SEED_B64=$(echo "$MINT_SEED_RAW" | grep -i "PLAINTEXT" | sed 's/.*: *//' || echo "$MINT_SEED_RAW")
    if [[ -z "$MINT_SEED_B64" ]]; then
        MINT_SEED_B64="$MINT_SEED_RAW"
    fi
    # Convert from base64 to hex
    MINT_SEED=$(echo -n "$MINT_SEED_B64" | base64 -d | od -A n -t x1 | tr -d ' \n')

    log_info "Decrypting ENCRYPTION_KEY via KMS attestation..."
    ENC_KEY_RAW=$(kms_decrypt "$ENC_KEY_CIPHERTEXT")
    if [[ -z "$ENC_KEY_RAW" ]]; then
        log_error "Failed to decrypt ENCRYPTION_KEY"
        exit 1
    fi
    log_debug "ENCRYPTION_KEY decrypt raw output: $ENC_KEY_RAW"
    # Extract base64 from PLAINTEXT line if present, otherwise use raw output
    ENC_KEY_B64=$(echo "$ENC_KEY_RAW" | grep -i "PLAINTEXT" | sed 's/.*: *//' || echo "$ENC_KEY_RAW")
    if [[ -z "$ENC_KEY_B64" ]]; then
        ENC_KEY_B64="$ENC_KEY_RAW"
    fi
    ENCRYPTION_KEY=$(echo -n "$ENC_KEY_B64" | base64 -d | od -A n -t x1 | tr -d ' \n')

    log_info "Secrets decrypted successfully via KMS attestation"
fi

# Export secrets to environment
export MINT_SEED
export ENCRYPTION_KEY

# Clear sensitive variables from shell
unset MINT_SEED_CIPHERTEXT
unset ENC_KEY_CIPHERTEXT
unset MINT_SEED_B64
unset ENC_KEY_B64
unset MINT_SEED_PLAINTEXT_B64
unset ENC_KEY_PLAINTEXT_B64
unset MINT_SEED_CIPHERTEXT_B64
unset ENC_KEY_CIPHERTEXT_B64
unset MINT_SEED_RESULT
unset ENC_KEY_RESULT
unset secrets_json
unset CRED_ACCESS_KEY
unset CRED_SECRET_KEY
unset CRED_SESSION_TOKEN

log_info "Secrets unsealing complete"

# Verify secrets are valid hex strings
if ! [[ "$MINT_SEED" =~ ^[0-9a-fA-F]{64}$ ]]; then
    log_error "MINT_SEED is not a valid 64-character hex string"
    exit 1
fi

if ! [[ "$ENCRYPTION_KEY" =~ ^[0-9a-fA-F]{64}$ ]]; then
    log_error "ENCRYPTION_KEY is not a valid 64-character hex string"
    exit 1
fi

log_info "Secrets validated successfully"
