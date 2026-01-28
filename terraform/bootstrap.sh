#!/bin/bash
# Bootstrap Script for Ducat Mint Enclave
#
# This script performs the initial infrastructure setup:
# 1. Creates AWS resources (EC2, KMS, IAM, ACM)
# 2. Sets up GitHub OIDC trust
# 3. Outputs DNS records for certificate validation
#
# Prerequisites:
# - AWS CLI configured with admin credentials
# - Terraform >= 1.0 installed
# - SSH key pair created in AWS Console
#
# Usage:
#   cd terraform
#   ./bootstrap.sh

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $*"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }
log_step() { echo -e "${BLUE}[STEP]${NC} $*"; }

# Check prerequisites
check_prerequisites() {
    log_step "Checking prerequisites..."

    if ! command -v terraform &> /dev/null; then
        log_error "Terraform not installed. Install from: https://terraform.io/downloads"
        exit 1
    fi

    if ! command -v aws &> /dev/null; then
        log_error "AWS CLI not installed. Install from: https://aws.amazon.com/cli/"
        exit 1
    fi

    # Check AWS credentials
    if ! aws sts get-caller-identity &> /dev/null; then
        log_error "AWS credentials not configured. Run: aws configure"
        exit 1
    fi

    ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
    log_info "Using AWS Account: $ACCOUNT_ID"

    # Check terraform.tfvars
    if [[ ! -f terraform.tfvars ]]; then
        log_error "terraform.tfvars not found"
        log_info "Copy terraform.tfvars.example to terraform.tfvars and configure it"
        exit 1
    fi

    # Check for placeholder password
    if grep -q "CHANGE_ME" terraform.tfvars; then
        log_error "Please change the db_password in terraform.tfvars"
        log_info "Generate one with: openssl rand -base64 24"
        exit 1
    fi

    log_info "Prerequisites check passed"
}

# Check if SSH key pair exists
check_key_pair() {
    log_step "Checking SSH key pair..."

    KEY_NAME=$(grep key_pair_name terraform.tfvars | cut -d'"' -f2)

    if ! aws ec2 describe-key-pairs --key-names "$KEY_NAME" &> /dev/null; then
        log_error "SSH key pair '$KEY_NAME' not found in AWS"
        log_info "Create it in AWS Console: EC2 -> Key Pairs -> Create key pair"
        exit 1
    fi

    log_info "SSH key pair '$KEY_NAME' found"
}

# Initialize Terraform
init_terraform() {
    log_step "Initializing Terraform..."
    terraform init
}

# Plan infrastructure
plan_infrastructure() {
    log_step "Planning infrastructure..."
    terraform plan -out=tfplan

    echo ""
    log_info "Review the plan above"
    read -p "Continue with apply? (yes/no): " CONFIRM

    if [[ "$CONFIRM" != "yes" ]]; then
        log_warn "Aborted by user"
        exit 0
    fi
}

# Apply infrastructure
apply_infrastructure() {
    log_step "Applying infrastructure..."
    terraform apply tfplan
    rm tfplan
}

# Show outputs and next steps
show_next_steps() {
    echo ""
    echo "=========================================="
    echo "           DEPLOYMENT COMPLETE"
    echo "=========================================="
    echo ""

    # Get outputs
    PUBLIC_IP=$(terraform output -raw public_ip 2>/dev/null || echo "pending")
    DOMAIN=$(terraform output -raw mint_url 2>/dev/null || echo "pending")
    ROLE_ARN=$(terraform output -raw github_actions_role_arn 2>/dev/null || echo "pending")

    log_info "Instance Public IP: $PUBLIC_IP"
    log_info "GitHub Actions Role: $ROLE_ARN"
    echo ""

    log_step "REQUIRED: Add DNS Records"
    echo ""
    echo "1. Add ACM certificate validation record:"
    terraform output -json acm_validation_records 2>/dev/null | jq -r 'to_entries[] | "   \(.value.type) \(.value.name) -> \(.value.value)"' || echo "   (see AWS Console for records)"
    echo ""
    echo "2. Add A record for your domain:"
    echo "   A cashu-mint.ducatprotocol.com -> $PUBLIC_IP"
    echo ""

    log_step "NEXT: Push to GitHub"
    echo ""
    echo "1. Push this code to: https://github.com/DUCAT-UNIT/unit-cashu-mint"
    echo ""
    echo "2. First deployment (generates secrets):"
    echo "   - Go to Actions tab in GitHub"
    echo "   - Run 'Deploy Enclave' workflow manually"
    echo "   - Check 'Generate new secrets' checkbox"
    echo ""
    echo "3. Subsequent deployments are automatic on push to main"
    echo ""

    log_step "VERIFY: Test endpoints"
    echo ""
    echo "After DNS propagation (~5-10 minutes):"
    echo "   curl https://cashu-mint.ducatprotocol.com/health"
    echo "   curl https://cashu-mint.ducatprotocol.com/v1/info"
    echo ""
}

# Main
main() {
    echo "=========================================="
    echo "    Ducat Mint Enclave Bootstrap"
    echo "=========================================="
    echo ""

    check_prerequisites
    check_key_pair
    init_terraform
    plan_infrastructure
    apply_infrastructure
    show_next_steps
}

main "$@"
