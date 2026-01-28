#!/bin/bash
# Parent Instance Setup Script for Nitro Enclave
#
# This script sets up the parent EC2 instance with:
# - Nitro Enclaves CLI and allocator
# - PostgreSQL database
# - vsock proxies for enclave connectivity
# - HAProxy/socat for TCP passthrough
#
# Prerequisites:
# - Amazon Linux 2023 or AL2 with Nitro Enclave support
# - Instance type with enclave support (m5.xlarge or larger)
# - Enclave support enabled in instance launch config

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $*"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $*"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $*" >&2
}

# Check if running as root
if [[ $EUID -ne 0 ]]; then
    log_error "This script must be run as root"
    exit 1
fi

# Detect OS
if [[ -f /etc/os-release ]]; then
    . /etc/os-release
    OS=$NAME
else
    log_error "Cannot detect OS"
    exit 1
fi

log_info "Setting up Nitro Enclave parent instance on $OS"

# =============================================================================
# Step 1: Install Nitro Enclaves CLI
# =============================================================================
log_info "Installing Nitro Enclaves CLI..."

if [[ "$OS" == *"Amazon Linux"* ]]; then
    # Amazon Linux 2023
    dnf install -y aws-nitro-enclaves-cli aws-nitro-enclaves-cli-devel
else
    # Amazon Linux 2
    amazon-linux-extras install aws-nitro-enclaves-cli -y
    yum install -y aws-nitro-enclaves-cli-devel
fi

# Add ec2-user to ne group
usermod -aG ne ec2-user

log_info "Nitro Enclaves CLI installed"

# =============================================================================
# Step 2: Configure Nitro Enclaves Allocator
# =============================================================================
log_info "Configuring Nitro Enclaves allocator..."

# Create allocator config
cat > /etc/nitro_enclaves/allocator.yaml << 'EOF'
# Nitro Enclaves allocator configuration
# Memory and CPU allocated to enclaves

# Memory in MiB (4GB for mint enclave)
memory_mib: 4096

# Number of CPU cores (2 for mint enclave)
cpu_count: 2
EOF

# Enable and start allocator
systemctl enable nitro-enclaves-allocator.service
systemctl start nitro-enclaves-allocator.service

log_info "Nitro Enclaves allocator configured (4GB RAM, 2 CPUs)"

# =============================================================================
# Step 3: Install PostgreSQL
# =============================================================================
log_info "Installing PostgreSQL..."

if [[ "$OS" == *"Amazon Linux 2023"* ]]; then
    dnf install -y postgresql15-server postgresql15
else
    amazon-linux-extras install postgresql15 -y
fi

# Initialize database
postgresql-setup --initdb

# Configure PostgreSQL to listen on localhost only
sed -i "s/#listen_addresses = 'localhost'/listen_addresses = 'localhost'/" /var/lib/pgsql/data/postgresql.conf

# Configure authentication
cat >> /var/lib/pgsql/data/pg_hba.conf << 'EOF'

# Enclave connections via vsock (appear as localhost)
host    mintdb      mintuser    127.0.0.1/32    scram-sha-256
host    mintdb      mintuser    ::1/128         scram-sha-256
EOF

# Enable and start PostgreSQL
systemctl enable postgresql
systemctl start postgresql

# Create database and user
log_info "Creating mint database..."
sudo -u postgres psql << 'EOF'
CREATE DATABASE mintdb;
CREATE USER mintuser WITH ENCRYPTED PASSWORD 'CHANGE_THIS_PASSWORD';
GRANT ALL PRIVILEGES ON DATABASE mintdb TO mintuser;
\c mintdb
GRANT ALL ON SCHEMA public TO mintuser;
EOF

log_info "PostgreSQL installed and configured"

# =============================================================================
# Step 4: Install vsock-proxy
# =============================================================================
log_info "Installing vsock-proxy..."

# vsock-proxy is included with nitro-enclaves-cli
# Just verify it exists
if ! command -v vsock-proxy &> /dev/null; then
    log_error "vsock-proxy not found. Install aws-nitro-enclaves-cli-devel"
    exit 1
fi

# Create config directory
mkdir -p /etc/vsock-proxy

# Copy proxy config
cp /opt/mint/parent/vsock-proxy-config.yaml /etc/vsock-proxy/config.yaml

# Install vsock-proxies service
cp /opt/mint/parent/vsock-proxies.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable vsock-proxies

log_info "vsock-proxy installed"

# =============================================================================
# Step 5: Install socat for vsock bridge
# =============================================================================
log_info "Installing socat..."

if [[ "$OS" == *"Amazon Linux 2023"* ]]; then
    dnf install -y socat
else
    yum install -y socat
fi

# Install vsock bridge service
cp /opt/mint/parent/vsock-bridge.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable vsock-bridge

log_info "socat installed"

# =============================================================================
# Step 6: Install ACM for Nitro Enclaves (optional)
# =============================================================================
log_info "Installing ACM for Nitro Enclaves..."

if [[ "$OS" == *"Amazon Linux 2023"* ]]; then
    dnf install -y aws-nitro-enclaves-acm
else
    amazon-linux-extras install aws-nitro-enclaves-acm -y 2>/dev/null || {
        log_warn "ACM for Nitro Enclaves not available on this platform"
    }
fi

log_info "ACM for Nitro Enclaves installed"

# =============================================================================
# Step 7: Configure firewall
# =============================================================================
log_info "Configuring firewall..."

# Allow HTTPS inbound
firewall-cmd --permanent --add-port=443/tcp 2>/dev/null || {
    # If firewalld not running, use iptables
    iptables -A INPUT -p tcp --dport 443 -j ACCEPT
}

# Allow health check port
firewall-cmd --permanent --add-port=8080/tcp 2>/dev/null || {
    iptables -A INPUT -p tcp --dport 8080 -j ACCEPT
}

log_info "Firewall configured"

# =============================================================================
# Step 8: Create mint user
# =============================================================================
log_info "Creating mint user..."

useradd -r -s /bin/false mintuser 2>/dev/null || log_info "User mintuser already exists"

# Create directories
mkdir -p /opt/mint/{enclave,parent,logs}
chown -R mintuser:mintuser /opt/mint

log_info "Mint user created"

# =============================================================================
# Summary
# =============================================================================
log_info "Parent instance setup complete!"
echo ""
echo "Next steps:"
echo "1. Update /etc/vsock-proxy/config.yaml with your Ord/Esplora endpoints"
echo "2. Update PostgreSQL password in setup script and container config"
echo "3. Configure KMS key with attestation policy"
echo "4. Build and copy enclave EIF to /opt/mint/enclave/"
echo "5. Start services:"
echo "   systemctl start vsock-proxies"
echo "   systemctl start vsock-bridge"
echo "   nitro-cli run-enclave --eif-path /opt/mint/enclave/mint.eif ..."
echo ""
echo "Verify setup:"
echo "   nitro-cli describe-enclaves"
echo "   systemctl status vsock-proxies"
echo "   systemctl status postgresql"
