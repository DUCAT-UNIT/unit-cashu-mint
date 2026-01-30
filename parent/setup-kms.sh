#!/bin/bash
# KMS Key Setup for Ducat Mint Enclave
#
# This script creates a KMS key with an attestation-based policy that:
# - Allows the enclave to Encrypt (first boot - generate and seal secrets)
# - Allows the enclave to Decrypt ONLY with valid attestation (normal boot)
#
# The PCR0 hash ensures only the exact enclave image can decrypt the secrets.
# Anyone with access to the parent instance cannot decrypt the secrets.

set -euo pipefail

# Configuration
AWS_REGION="${AWS_REGION:-us-east-1}"
KEY_ALIAS="${KEY_ALIAS:-alias/ducat-mint-secrets}"

log_info() {
    echo "[kms-setup] [INFO] $*"
}

log_error() {
    echo "[kms-setup] [ERROR] $*" >&2
}

# Get AWS account ID
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
log_info "AWS Account ID: $ACCOUNT_ID"

# Check if enclave image exists and get PCR0
EIF_PATH="${EIF_PATH:-/opt/enclave/mint-enclave.eif}"
if [[ -f "$EIF_PATH" ]]; then
    log_info "Getting PCR0 from enclave image..."
    PCR0=$(nitro-cli describe-eif --eif-path "$EIF_PATH" | jq -r '.Measurements.PCR0')
    log_info "PCR0: $PCR0"
else
    log_info "Enclave image not found at $EIF_PATH"
    log_info "Using placeholder PCR0 - UPDATE THIS after building the enclave!"
    PCR0="000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
fi

# Create the key policy
log_info "Creating KMS key policy..."

POLICY=$(cat << EOF
{
  "Version": "2012-10-17",
  "Id": "ducat-mint-enclave-key-policy",
  "Statement": [
    {
      "Sid": "AllowRootFullAccess",
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::${ACCOUNT_ID}:root"
      },
      "Action": "kms:*",
      "Resource": "*"
    },
    {
      "Sid": "AllowEnclaveRoleBasicAccess",
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::${ACCOUNT_ID}:role/DucatMintEnclaveRole"
      },
      "Action": [
        "kms:Encrypt",
        "kms:GenerateDataKey"
      ],
      "Resource": "*"
    },
    {
      "Sid": "AllowEnclaveDecryptWithAttestation",
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::${ACCOUNT_ID}:role/DucatMintEnclaveRole"
      },
      "Action": "kms:Decrypt",
      "Resource": "*",
      "Condition": {
        "StringEqualsIgnoreCase": {
          "kms:RecipientAttestation:ImageSha384": "${PCR0}"
        }
      }
    }
  ]
}
EOF
)

# Check if key already exists
EXISTING_KEY=$(aws kms describe-key --key-id "$KEY_ALIAS" --region "$AWS_REGION" 2>/dev/null | jq -r '.KeyMetadata.KeyId' || echo "")

if [[ -n "$EXISTING_KEY" ]]; then
    log_info "KMS key already exists: $EXISTING_KEY"
    log_info "Updating key policy..."

    aws kms put-key-policy \
        --key-id "$EXISTING_KEY" \
        --policy-name default \
        --policy "$POLICY" \
        --region "$AWS_REGION"

    KMS_KEY_ID="$EXISTING_KEY"
else
    log_info "Creating new KMS key..."

    KMS_KEY_ID=$(aws kms create-key \
        --description "Ducat Mint Enclave Secrets Key" \
        --policy "$POLICY" \
        --region "$AWS_REGION" \
        --output text \
        --query 'KeyMetadata.KeyId')

    log_info "Created KMS key: $KMS_KEY_ID"

    # Create alias
    aws kms create-alias \
        --alias-name "$KEY_ALIAS" \
        --target-key-id "$KMS_KEY_ID" \
        --region "$AWS_REGION" 2>/dev/null || true

    log_info "Created alias: $KEY_ALIAS"
fi

# Get the full ARN
KMS_KEY_ARN=$(aws kms describe-key --key-id "$KMS_KEY_ID" --region "$AWS_REGION" --query 'KeyMetadata.Arn' --output text)

echo ""
echo "=== KMS Key Setup Complete ==="
echo ""
echo "KMS Key ID:  $KMS_KEY_ID"
echo "KMS Key ARN: $KMS_KEY_ARN"
echo "PCR0 Hash:   $PCR0"
echo ""
echo "Add this to your enclave environment:"
echo "  export KMS_KEY_ID=$KMS_KEY_ARN"
echo ""
echo "IMPORTANT: After rebuilding the enclave, update the PCR0 in the key policy:"
echo "  ./setup-kms.sh"
echo ""
