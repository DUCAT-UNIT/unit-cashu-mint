#!/bin/bash
# KMS Secrets Unsealing Script for Nitro Enclave
#
# This script handles the secure generation and retrieval of cryptographic secrets
# using AWS KMS with Nitro Enclave attestation.
#
# Modes:
# 1. FIRST_BOOT=true: Generate new secrets, encrypt with KMS, store ciphertext
# 2. Normal boot: Retrieve ciphertext, decrypt via KMS attestation
#
# Secrets managed:
# - MINT_SEED: 32-byte seed for deterministic key derivation
# - ENCRYPTION_KEY: 32-byte key for encrypting private keys in database
#
# Environment variables required:
# - KMS_KEY_ID: ARN of KMS key with attestation policy
# - AWS_REGION: AWS region (default: us-east-1)
# - SECRETS_BUCKET: S3 bucket for encrypted secrets (optional, uses vsock file transfer if not set)
# - FIRST_BOOT: Set to "true" for initial key generation

set -euo pipefail

# Configuration
KMS_KEY_ID="${KMS_KEY_ID:-}"
AWS_REGION="${AWS_REGION:-us-east-1}"
SECRETS_PATH="${SECRETS_PATH:-/run/secrets}"
FIRST_BOOT="${FIRST_BOOT:-false}"

# Nitro Enclave NSM (Nitro Security Module) device
NSM_DEVICE="/dev/nsm"

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
    [[ -c "$NSM_DEVICE" ]]
}

# Generate attestation document from Nitro Security Module
get_attestation_document() {
    local user_data="$1"
    local nonce="$2"

    if ! is_enclave; then
        log_error "Not running inside Nitro Enclave - NSM device not found"
        return 1
    fi

    # Use NSM CLI to generate attestation
    # The attestation document contains PCR values that KMS validates
    nitro-cli attestation \
        --user-data "$user_data" \
        --nonce "$nonce" \
        2>/dev/null
}

# Call KMS via vsock proxy with attestation
kms_decrypt_with_attestation() {
    local ciphertext_blob="$1"
    local attestation_doc
    local nonce
    local response

    # Generate nonce for this request
    nonce=$(openssl rand -hex 16)

    # Get attestation document
    attestation_doc=$(get_attestation_document "kms-decrypt" "$nonce")

    if [[ -z "$attestation_doc" ]]; then
        log_error "Failed to generate attestation document"
        return 1
    fi

    # Call KMS Decrypt with recipient attestation
    # KMS validates PCR values before releasing plaintext
    response=$(aws kms decrypt \
        --key-id "$KMS_KEY_ID" \
        --ciphertext-blob fileb://<(echo -n "$ciphertext_blob" | base64 -d) \
        --recipient "{\"KeyEncryptionAlgorithm\": \"RSAES_OAEP_SHA_256\", \"AttestationDocument\": \"$attestation_doc\"}" \
        --region "$AWS_REGION" \
        --endpoint-url "https://localhost:8443" \
        --output json \
        2>/dev/null)

    if [[ -z "$response" ]]; then
        log_error "KMS decrypt call failed"
        return 1
    fi

    # Extract plaintext (returned encrypted to enclave, decrypted via NSM)
    echo "$response" | jq -r '.Plaintext' | base64 -d
}

# Encrypt data using KMS (only for first boot)
kms_encrypt() {
    local plaintext="$1"
    local response

    response=$(aws kms encrypt \
        --key-id "$KMS_KEY_ID" \
        --plaintext fileb://<(echo -n "$plaintext") \
        --region "$AWS_REGION" \
        --endpoint-url "https://localhost:8443" \
        --output json \
        2>/dev/null)

    if [[ -z "$response" ]]; then
        log_error "KMS encrypt call failed"
        return 1
    fi

    echo "$response" | jq -r '.CiphertextBlob'
}

# Generate cryptographically secure random bytes
generate_secret() {
    local length="${1:-32}"
    openssl rand -hex "$length"
}

# Store encrypted secret (via vsock to parent)
store_encrypted_secret() {
    local name="$1"
    local ciphertext="$2"
    local secrets_file="${SECRETS_PATH}/encrypted_secrets.json"

    # Ensure secrets directory exists
    mkdir -p "$SECRETS_PATH"

    # Read existing secrets or create empty object
    local secrets="{}"
    if [[ -f "$secrets_file" ]]; then
        secrets=$(cat "$secrets_file")
    fi

    # Update with new secret
    secrets=$(echo "$secrets" | jq --arg name "$name" --arg ct "$ciphertext" '.[$name] = $ct')

    # Write back
    echo "$secrets" > "$secrets_file"
    chmod 600 "$secrets_file"

    log_debug "Stored encrypted secret: $name"
}

# Retrieve encrypted secret
get_encrypted_secret() {
    local name="$1"
    local secrets_file="${SECRETS_PATH}/encrypted_secrets.json"

    if [[ ! -f "$secrets_file" ]]; then
        log_error "Secrets file not found: $secrets_file"
        return 1
    fi

    local ciphertext
    ciphertext=$(jq -r --arg name "$name" '.[$name] // empty' "$secrets_file")

    if [[ -z "$ciphertext" ]]; then
        log_error "Secret not found: $name"
        return 1
    fi

    echo "$ciphertext"
}

# ============================================================================
# Main unsealing logic
# ============================================================================

log_info "Starting secrets unsealing process..."

# Check for KMS key ID
if [[ -z "$KMS_KEY_ID" ]]; then
    log_error "KMS_KEY_ID environment variable not set"

    # Development mode: use environment variables directly if set
    if [[ -n "${MINT_SEED:-}" ]] && [[ -n "${ENCRYPTION_KEY:-}" ]]; then
        log_info "Using pre-configured secrets (development mode)"
        export MINT_SEED
        export ENCRYPTION_KEY
        return 0 2>/dev/null || exit 0
    fi

    exit 1
fi

# Create secrets directory
mkdir -p "$SECRETS_PATH"

if [[ "$FIRST_BOOT" == "true" ]]; then
    # ========================================================================
    # First Boot: Generate and seal new secrets
    # ========================================================================
    log_info "First boot detected - generating new secrets..."

    # Generate new secrets
    MINT_SEED=$(generate_secret 32)
    ENCRYPTION_KEY=$(generate_secret 32)

    log_info "Generated MINT_SEED and ENCRYPTION_KEY"

    # Encrypt secrets with KMS
    log_info "Encrypting secrets with KMS..."

    MINT_SEED_ENCRYPTED=$(kms_encrypt "$MINT_SEED")
    if [[ -z "$MINT_SEED_ENCRYPTED" ]]; then
        log_error "Failed to encrypt MINT_SEED"
        exit 1
    fi

    ENCRYPTION_KEY_ENCRYPTED=$(kms_encrypt "$ENCRYPTION_KEY")
    if [[ -z "$ENCRYPTION_KEY_ENCRYPTED" ]]; then
        log_error "Failed to encrypt ENCRYPTION_KEY"
        exit 1
    fi

    # Store encrypted secrets
    log_info "Storing encrypted secrets..."
    store_encrypted_secret "MINT_SEED" "$MINT_SEED_ENCRYPTED"
    store_encrypted_secret "ENCRYPTION_KEY" "$ENCRYPTION_KEY_ENCRYPTED"

    log_info "First boot complete - secrets generated and sealed"

else
    # ========================================================================
    # Normal Boot: Retrieve and unseal existing secrets
    # ========================================================================
    log_info "Retrieving encrypted secrets..."

    # Get encrypted secrets
    MINT_SEED_ENCRYPTED=$(get_encrypted_secret "MINT_SEED")
    if [[ -z "$MINT_SEED_ENCRYPTED" ]]; then
        log_error "MINT_SEED not found - run with FIRST_BOOT=true to generate"
        exit 1
    fi

    ENCRYPTION_KEY_ENCRYPTED=$(get_encrypted_secret "ENCRYPTION_KEY")
    if [[ -z "$ENCRYPTION_KEY_ENCRYPTED" ]]; then
        log_error "ENCRYPTION_KEY not found - run with FIRST_BOOT=true to generate"
        exit 1
    fi

    # Decrypt secrets using KMS with attestation
    log_info "Decrypting secrets via KMS attestation..."

    MINT_SEED=$(kms_decrypt_with_attestation "$MINT_SEED_ENCRYPTED")
    if [[ -z "$MINT_SEED" ]]; then
        log_error "Failed to decrypt MINT_SEED"
        exit 1
    fi

    ENCRYPTION_KEY=$(kms_decrypt_with_attestation "$ENCRYPTION_KEY_ENCRYPTED")
    if [[ -z "$ENCRYPTION_KEY" ]]; then
        log_error "Failed to decrypt ENCRYPTION_KEY"
        exit 1
    fi

    log_info "Secrets decrypted successfully"
fi

# Export secrets to environment
export MINT_SEED
export ENCRYPTION_KEY

# Clear sensitive variables from shell history
unset MINT_SEED_ENCRYPTED
unset ENCRYPTION_KEY_ENCRYPTED

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
