#!/bin/bash
# Enclave Build Script
# Builds the Nitro Enclave EIF (Enclave Image File)
#
# Prerequisites:
# - Amazon Linux 2 or AL2023 with Nitro Enclaves support
# - nitro-cli installed
# - Docker installed and running
#
# Usage:
#   ./enclave/build.sh
#   ./enclave/build.sh --debug    # Build with debug mode

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
OUTPUT_DIR="${PROJECT_DIR}/build"
EIF_NAME="mint-enclave.eif"
DOCKER_IMAGE="mint-enclave:latest"
DEBUG_MODE=""

# KMS configuration (can be overridden via environment)
KMS_KEY_ID="${KMS_KEY_ID:-}"
AWS_REGION="${AWS_REGION:-us-east-1}"
FIRST_BOOT="${FIRST_BOOT:-false}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() {
    echo -e "${GREEN}[INFO]${NC} $*"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $*"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $*" >&2
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --debug)
            DEBUG_MODE="--debug-mode"
            shift
            ;;
        *)
            log_error "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Check prerequisites
log_info "Checking prerequisites..."

if ! command -v docker &> /dev/null; then
    log_error "Docker is not installed"
    exit 1
fi

if ! command -v nitro-cli &> /dev/null; then
    log_error "nitro-cli is not installed"
    log_info "Install with: sudo amazon-linux-extras install aws-nitro-enclaves-cli -y"
    exit 1
fi

# Check if Docker is running
if ! docker info &> /dev/null; then
    log_error "Docker daemon is not running"
    exit 1
fi

# Create output directory
mkdir -p "$OUTPUT_DIR"

# Step 1: Build TypeScript
log_info "Building TypeScript application..."
cd "$PROJECT_DIR"

npm ci
npm run build

# Step 2: Build Docker image
log_info "Building Docker image..."

# Pass KMS configuration as build args
DOCKER_BUILD_ARGS=""
if [[ -n "$KMS_KEY_ID" ]]; then
    log_info "KMS Key ID: $KMS_KEY_ID"
    DOCKER_BUILD_ARGS="$DOCKER_BUILD_ARGS --build-arg KMS_KEY_ID=$KMS_KEY_ID"
fi
if [[ -n "$AWS_REGION" ]]; then
    DOCKER_BUILD_ARGS="$DOCKER_BUILD_ARGS --build-arg AWS_REGION=$AWS_REGION"
fi
if [[ "$FIRST_BOOT" == "true" ]]; then
    log_info "Building for FIRST BOOT (will generate and seal new secrets)"
    DOCKER_BUILD_ARGS="$DOCKER_BUILD_ARGS --build-arg FIRST_BOOT=true"
fi

docker build --no-cache \
    -t "$DOCKER_IMAGE" \
    -f enclave/Dockerfile \
    $DOCKER_BUILD_ARGS \
    .

log_info "Docker image built: $DOCKER_IMAGE"

# Step 3: Build EIF
log_info "Building Nitro Enclave EIF..."

nitro-cli build-enclave \
    --docker-uri "$DOCKER_IMAGE" \
    --output-file "${OUTPUT_DIR}/${EIF_NAME}"

# Step 4: Describe EIF and extract PCR values
log_info "Extracting enclave measurements..."

EIF_INFO=$(nitro-cli describe-eif --eif-path "${OUTPUT_DIR}/${EIF_NAME}")

PCR0=$(echo "$EIF_INFO" | jq -r '.Measurements.PCR0')
PCR1=$(echo "$EIF_INFO" | jq -r '.Measurements.PCR1')
PCR2=$(echo "$EIF_INFO" | jq -r '.Measurements.PCR2')

# Save measurements to file
cat > "${OUTPUT_DIR}/measurements.json" << EOF
{
  "build_time": "$(date -Iseconds)",
  "eif_file": "${EIF_NAME}",
  "measurements": {
    "PCR0": "${PCR0}",
    "PCR1": "${PCR1}",
    "PCR2": "${PCR2}"
  }
}
EOF

# Print summary
log_info "Build complete!"
echo ""
echo "=== Enclave Image Summary ==="
echo "EIF file: ${OUTPUT_DIR}/${EIF_NAME}"
echo ""
echo "=== PCR Measurements ==="
echo "PCR0 (enclave image): ${PCR0}"
echo "PCR1 (Linux kernel):  ${PCR1}"
echo "PCR2 (application):   ${PCR2}"
echo ""
echo "=== KMS Policy Update ==="
echo "Update your KMS key policy with the following PCR0 value:"
echo ""
echo "  \"kms:RecipientAttestation:PCR0\": \"${PCR0}\""
echo ""
echo "=== Next Steps ==="
echo "1. Copy EIF to EC2: scp ${OUTPUT_DIR}/${EIF_NAME} ec2-user@<host>:/opt/mint/enclave/"
echo "2. Update KMS policy with PCR0 hash"
echo "3. Run enclave:"
echo "   nitro-cli run-enclave \\"
echo "     --enclave-cid 16 \\"
echo "     --eif-path /opt/mint/enclave/${EIF_NAME} \\"
echo "     --memory 4096 \\"
echo "     --cpu-count 2 ${DEBUG_MODE}"
