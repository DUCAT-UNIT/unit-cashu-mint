#!/bin/bash
# Parent Instance Proxy Setup for Nitro Enclave
#
# This script sets up the required proxies on the parent EC2 instance:
# 1. Inbound TCP passthrough: Internet :443 -> enclave vsock:8443
# 2. Egress proxy for KMS: enclave vsock:443 -> kms.amazonaws.com:443
# 3. Egress proxy for PostgreSQL: enclave vsock:5432 -> localhost:5432
#
# Security model:
# - Parent ONLY does L4 TCP forwarding (no TLS termination)
# - Parent sees only encrypted TLS bytes, never plaintext HTTP
# - All TLS termination happens inside the enclave

set -euo pipefail

# Configuration
ENCLAVE_CID="${ENCLAVE_CID:-16}"
AWS_REGION="${AWS_REGION:-us-east-1}"
HTTPS_PORT="${HTTPS_PORT:-8443}"

log_info() {
    echo "[parent] [INFO] $*"
}

log_error() {
    echo "[parent] [ERROR] $*" >&2
}

# ============================================================================
# Prerequisites check
# ============================================================================
log_info "Checking prerequisites..."

if ! command -v vsock-proxy &> /dev/null; then
    log_error "vsock-proxy not found. Install aws-nitro-enclaves-cli"
    exit 1
fi

if ! command -v socat &> /dev/null; then
    log_info "Installing socat..."
    sudo yum install -y socat || sudo apt-get install -y socat
fi

# ============================================================================
# Create vsock-proxy config
# ============================================================================
log_info "Creating vsock-proxy configuration..."

sudo mkdir -p /etc/vsock-proxy

sudo tee /etc/vsock-proxy/config.yaml > /dev/null << EOF
# vsock-proxy allowlist for Ducat Mint Enclave
# Only these endpoints can be reached from inside the enclave

allowlist:
  # PostgreSQL (local)
  - { address: 127.0.0.1, port: 5432 }

  # AWS KMS API
  - { address: kms.${AWS_REGION}.amazonaws.com, port: 443 }

  # AWS STS (for IAM credentials)
  - { address: sts.${AWS_REGION}.amazonaws.com, port: 443 }

  # AWS ACM (for certificate provisioning)
  - { address: acm.${AWS_REGION}.amazonaws.com, port: 443 }
EOF

log_info "vsock-proxy config created at /etc/vsock-proxy/config.yaml"

# ============================================================================
# Create systemd services
# ============================================================================
log_info "Creating systemd services..."

# 1. Inbound HTTPS passthrough (Internet -> Enclave)
# TCP-only, no TLS termination - parent sees only encrypted bytes
sudo tee /etc/systemd/system/mint-inbound.service > /dev/null << EOF
[Unit]
Description=Mint Inbound TCP Passthrough (443 -> enclave vsock:${HTTPS_PORT})
After=network.target nitro-enclaves-allocator.service

[Service]
Type=simple
ExecStart=/usr/bin/socat TCP-LISTEN:443,fork,reuseaddr VSOCK-CONNECT:${ENCLAVE_CID}:${HTTPS_PORT}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# 2. PostgreSQL vsock proxy (Enclave -> Local Postgres)
sudo tee /etc/systemd/system/mint-postgres-proxy.service > /dev/null << EOF
[Unit]
Description=Mint PostgreSQL vsock Proxy (enclave vsock:5432 -> localhost:5432)
After=network.target postgresql.service

[Service]
Type=simple
ExecStart=/usr/bin/vsock-proxy 5432 127.0.0.1 5432 --config /etc/vsock-proxy/config.yaml
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# 3. KMS API vsock proxy (Enclave -> AWS KMS)
sudo tee /etc/systemd/system/mint-kms-proxy.service > /dev/null << EOF
[Unit]
Description=Mint KMS vsock Proxy (enclave vsock:443 -> kms.amazonaws.com:443)
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/vsock-proxy 443 kms.${AWS_REGION}.amazonaws.com 443 --config /etc/vsock-proxy/config.yaml
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Reload systemd
sudo systemctl daemon-reload

log_info "Systemd services created"

# ============================================================================
# Enable and start services
# ============================================================================
log_info "Enabling and starting services..."

sudo systemctl enable mint-postgres-proxy.service
sudo systemctl enable mint-kms-proxy.service
sudo systemctl enable mint-inbound.service

sudo systemctl start mint-postgres-proxy.service
sudo systemctl start mint-kms-proxy.service
# Don't start inbound until enclave is running
# sudo systemctl start mint-inbound.service

log_info "PostgreSQL and KMS proxies started"
log_info "Run 'sudo systemctl start mint-inbound.service' after enclave is running"

# ============================================================================
# Verify setup
# ============================================================================
log_info "Verifying setup..."

echo ""
echo "=== Service Status ==="
systemctl status mint-postgres-proxy.service --no-pager || true
systemctl status mint-kms-proxy.service --no-pager || true

echo ""
echo "=== Listening Ports ==="
ss -tlnp | grep -E ':(443|5432)' || echo "No ports listening yet"

echo ""
log_info "Parent proxy setup complete!"
echo ""
echo "Next steps:"
echo "  1. Build and run the enclave: cd enclave && ./build.sh && nitro-cli run-enclave ..."
echo "  2. Start inbound proxy: sudo systemctl start mint-inbound.service"
echo "  3. Test: curl -k https://localhost/health"
