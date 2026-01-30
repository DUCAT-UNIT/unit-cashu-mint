#!/bin/bash
# Install systemd services for Mint Enclave
# Run as root on the EC2 instance

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== Installing Mint Enclave systemd services ==="

# Create directories
mkdir -p /opt/mint-enclave
mkdir -p /opt/mint-enclave/secrets
mkdir -p /etc/nitro_enclaves

# Copy vsock-proxy config
echo "Installing vsock-proxy config..."
cp "$SCRIPT_DIR/vsock-proxy.yaml" /etc/nitro_enclaves/vsock-proxy.yaml

# Copy helper scripts
echo "Installing helper scripts..."
cp "$SCRIPT_DIR/send-credentials.sh" /opt/mint-enclave/
cp "$SCRIPT_DIR/send-secrets.sh" /opt/mint-enclave/
cp "$SCRIPT_DIR/receive-secrets.sh" /opt/mint-enclave/
chmod +x /opt/mint-enclave/*.sh

# Copy systemd unit files
echo "Installing systemd unit files..."
cp "$SCRIPT_DIR/systemd/mint-postgres-proxy.service" /etc/systemd/system/
cp "$SCRIPT_DIR/systemd/mint-kms-proxy.service" /etc/systemd/system/
cp "$SCRIPT_DIR/systemd/mint-enclave.service" /etc/systemd/system/
cp "$SCRIPT_DIR/systemd/mint-https-proxy.service" /etc/systemd/system/
cp "$SCRIPT_DIR/systemd/mint-creds-sender.service" /etc/systemd/system/
cp "$SCRIPT_DIR/systemd/mint-secrets-sender.service" /etc/systemd/system/
cp "$SCRIPT_DIR/systemd/mint-secrets-receiver.service" /etc/systemd/system/

# Remove deprecated external-proxy if it exists
rm -f /etc/systemd/system/mint-external-proxy.service 2>/dev/null || true

# Reload systemd
echo "Reloading systemd..."
systemctl daemon-reload

# Enable services
echo "Enabling services..."
systemctl enable mint-postgres-proxy.service
systemctl enable mint-kms-proxy.service
systemctl enable mint-enclave.service
systemctl enable mint-https-proxy.service
# Credential and secrets senders are not enabled by default (manual trigger)

echo ""
echo "=== Services installed ==="
echo ""
echo "Core services (start on boot):"
echo "  - mint-postgres-proxy  : PostgreSQL vsock proxy"
echo "  - mint-kms-proxy       : KMS API vsock proxy"
echo "  - mint-enclave         : Nitro Enclave"
echo "  - mint-https-proxy     : HTTPS inbound proxy"
echo ""
echo "Helper services (manual trigger for KMS mode):"
echo "  - mint-creds-sender     : Send AWS credentials to enclave"
echo "  - mint-secrets-receiver : Receive encrypted secrets from enclave (first boot)"
echo "  - mint-secrets-sender   : Send encrypted secrets to enclave (normal boot)"
echo ""
echo "For FIRST BOOT (generate new secrets):"
echo "  1. Build enclave with FIRST_BOOT=true KMS_KEY_ID=<arn>"
echo "  2. Start core services"
echo "  3. Run: sudo systemctl start mint-secrets-receiver  (listen BEFORE sending creds)"
echo "  4. Run: sudo systemctl start mint-creds-sender"
echo "  5. Enclave generates keys, sends ciphertext to parent"
echo "  6. Verify: cat /opt/mint-enclave/secrets/encrypted_secrets.json"
echo ""
echo "For NORMAL BOOT (use existing secrets):"
echo "  1. Build enclave with KMS_KEY_ID=<arn> (no FIRST_BOOT)"
echo "  2. Ensure encrypted_secrets.json exists in /opt/mint-enclave/secrets/"
echo "  3. Start core services"
echo "  4. Run: sudo systemctl start mint-creds-sender mint-secrets-sender"
echo ""
echo "Make sure to copy the EIF file to /opt/mint-enclave/mint-enclave.eif"
