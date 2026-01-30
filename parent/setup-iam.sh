#!/bin/bash
# IAM Role Setup for Ducat Mint Enclave
#
# Creates the IAM role that the enclave uses to access KMS.
# This role is assumed by the EC2 instance profile.

set -euo pipefail

AWS_REGION="${AWS_REGION:-us-east-1}"
ROLE_NAME="${ROLE_NAME:-DucatMintEnclaveRole}"
INSTANCE_PROFILE_NAME="${INSTANCE_PROFILE_NAME:-DucatMintEnclaveProfile}"

log_info() {
    echo "[iam-setup] [INFO] $*"
}

log_error() {
    echo "[iam-setup] [ERROR] $*" >&2
}

# Get AWS account ID
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
log_info "AWS Account ID: $ACCOUNT_ID"

# Trust policy - allows EC2 to assume this role
TRUST_POLICY=$(cat << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "ec2.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF
)

# Role policy - allows KMS operations (actual permissions controlled by key policy)
ROLE_POLICY=$(cat << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowKMSOperations",
      "Effect": "Allow",
      "Action": [
        "kms:Encrypt",
        "kms:Decrypt",
        "kms:GenerateDataKey"
      ],
      "Resource": "arn:aws:kms:${AWS_REGION}:${ACCOUNT_ID}:key/*"
    }
  ]
}
EOF
)

# Check if role exists
EXISTING_ROLE=$(aws iam get-role --role-name "$ROLE_NAME" 2>/dev/null | jq -r '.Role.Arn' || echo "")

if [[ -n "$EXISTING_ROLE" ]]; then
    log_info "IAM role already exists: $EXISTING_ROLE"
else
    log_info "Creating IAM role: $ROLE_NAME"

    aws iam create-role \
        --role-name "$ROLE_NAME" \
        --assume-role-policy-document "$TRUST_POLICY" \
        --description "Role for Ducat Mint Nitro Enclave to access KMS"

    log_info "Created IAM role"
fi

# Attach inline policy
log_info "Updating role policy..."
aws iam put-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-name "DucatMintKMSAccess" \
    --policy-document "$ROLE_POLICY"

# Check if instance profile exists
EXISTING_PROFILE=$(aws iam get-instance-profile --instance-profile-name "$INSTANCE_PROFILE_NAME" 2>/dev/null | jq -r '.InstanceProfile.Arn' || echo "")

if [[ -n "$EXISTING_PROFILE" ]]; then
    log_info "Instance profile already exists: $EXISTING_PROFILE"
else
    log_info "Creating instance profile: $INSTANCE_PROFILE_NAME"

    aws iam create-instance-profile \
        --instance-profile-name "$INSTANCE_PROFILE_NAME"

    # Attach role to instance profile
    aws iam add-role-to-instance-profile \
        --instance-profile-name "$INSTANCE_PROFILE_NAME" \
        --role-name "$ROLE_NAME"

    log_info "Created instance profile and attached role"
fi

ROLE_ARN=$(aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text)
PROFILE_ARN=$(aws iam get-instance-profile --instance-profile-name "$INSTANCE_PROFILE_NAME" --query 'InstanceProfile.Arn' --output text)

echo ""
echo "=== IAM Setup Complete ==="
echo ""
echo "Role ARN:            $ROLE_ARN"
echo "Instance Profile:    $PROFILE_ARN"
echo ""
echo "Attach this instance profile to your EC2 instance:"
echo "  aws ec2 associate-iam-instance-profile \\"
echo "    --instance-id <instance-id> \\"
echo "    --iam-instance-profile Name=$INSTANCE_PROFILE_NAME"
echo ""
