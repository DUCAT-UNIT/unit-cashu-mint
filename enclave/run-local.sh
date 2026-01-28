#!/bin/bash
# Local Development Script for Enclave
# Runs the mint locally without actual enclave (for development/testing)
#
# This simulates the enclave environment by:
# - Running Node.js directly
# - Using local PostgreSQL
# - Skipping KMS attestation (uses env vars for secrets)
#
# Usage:
#   ./enclave/run-local.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() {
    echo -e "${GREEN}[INFO]${NC} $*"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $*"
}

# Check for .env file
if [[ ! -f "${PROJECT_DIR}/.env" ]]; then
    log_warn ".env file not found"
    log_info "Creating from template..."

    if [[ -f "${SCRIPT_DIR}/.env.template" ]]; then
        cp "${SCRIPT_DIR}/.env.template" "${PROJECT_DIR}/.env"
        log_warn "Please edit .env with your configuration"
        exit 1
    else
        log_warn "No template found - create .env manually"
        exit 1
    fi
fi

# Set enclave mode to false for local development
export ENCLAVE_MODE=false

log_info "Starting mint in local development mode..."
log_info "Enclave features disabled"

cd "$PROJECT_DIR"

# Check if built
if [[ ! -d "dist" ]]; then
    log_info "Building TypeScript..."
    npm run build
fi

# Start server
log_info "Starting server..."
npm run dev
