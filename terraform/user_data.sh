#!/bin/bash
# EC2 User Data Script for Ducat Mint Enclave
# This script runs on first boot to configure the instance

set -euo pipefail

# Logging
exec > >(tee /var/log/user-data.log) 2>&1
echo "Starting user data script at $(date)"

# Variables from Terraform template
DB_PASSWORD="${db_password}"
ENCLAVE_MEMORY_MIB="${enclave_memory_mib}"
ENCLAVE_CPU_COUNT="${enclave_cpu_count}"
KMS_KEY_ID="${kms_key_id}"
AWS_REGION="${aws_region}"
ACM_CERT_ARN="${acm_cert_arn}"

# =============================================================================
# Install packages
# =============================================================================
echo "Installing packages..."

dnf update -y
dnf install -y \
    aws-nitro-enclaves-cli \
    aws-nitro-enclaves-cli-devel \
    aws-nitro-enclaves-acm \
    postgresql15-server \
    postgresql15 \
    socat \
    jq \
    htop

# =============================================================================
# Configure Nitro Enclaves
# =============================================================================
echo "Configuring Nitro Enclaves..."

# Add ec2-user to ne group
usermod -aG ne ec2-user

# Configure allocator
cat > /etc/nitro_enclaves/allocator.yaml << EOF
memory_mib: $ENCLAVE_MEMORY_MIB
cpu_count: $ENCLAVE_CPU_COUNT
EOF

# Enable and start allocator
systemctl enable nitro-enclaves-allocator.service
systemctl start nitro-enclaves-allocator.service

# =============================================================================
# Configure PostgreSQL
# =============================================================================
echo "Configuring PostgreSQL..."

# Initialize database
postgresql-setup --initdb

# Configure to listen on localhost only
sed -i "s/#listen_addresses = 'localhost'/listen_addresses = 'localhost'/" /var/lib/pgsql/data/postgresql.conf

# Configure authentication
cat >> /var/lib/pgsql/data/pg_hba.conf << 'EOF'
host    mintdb      mintuser    127.0.0.1/32    scram-sha-256
host    mintdb      mintuser    ::1/128         scram-sha-256
EOF

# Enable and start PostgreSQL
systemctl enable postgresql
systemctl start postgresql

# Create database and user
sudo -u postgres psql << EOF
CREATE DATABASE mintdb;
CREATE USER mintuser WITH ENCRYPTED PASSWORD '$DB_PASSWORD';
GRANT ALL PRIVILEGES ON DATABASE mintdb TO mintuser;
\c mintdb
GRANT ALL ON SCHEMA public TO mintuser;
EOF

# =============================================================================
# Configure vsock proxies
# =============================================================================
echo "Configuring vsock proxies..."

mkdir -p /etc/vsock-proxy

cat > /etc/vsock-proxy/config.yaml << EOF
allowlist:
  - { host: localhost, port: 5432 }
  - { host: 127.0.0.1, port: 5432 }
  - { host: localhost, port: 6379 }
  - { host: 127.0.0.1, port: 6379 }
  - { host: kms.$AWS_REGION.amazonaws.com, port: 443 }
  - { host: acm.$AWS_REGION.amazonaws.com, port: 443 }
EOF

# Create vsock-proxies service
cat > /etc/systemd/system/vsock-proxies.service << 'EOF'
[Unit]
Description=vsock Proxies for Nitro Enclave
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
ExecStart=/bin/bash -c '/usr/bin/vsock-proxy 5432 localhost 5432 & /usr/bin/vsock-proxy 6379 localhost 6379 & /usr/bin/vsock-proxy 443 kms.${aws_region}.amazonaws.com 443 & wait'
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Create vsock-bridge service (Internet -> Enclave)
cat > /etc/systemd/system/vsock-bridge.service << 'EOF'
[Unit]
Description=vsock Bridge for Enclave TLS
After=network.target nitro-enclaves-allocator.service

[Service]
Type=simple
ExecStart=/usr/bin/socat TCP-LISTEN:443,fork,reuseaddr VSOCK-CONNECT:16:8443
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable vsock-proxies
systemctl enable vsock-bridge

# =============================================================================
# Configure ACM for Nitro Enclaves
# =============================================================================
echo "Configuring ACM for Nitro Enclaves..."

mkdir -p /etc/nitro_enclaves

cat > /etc/nitro_enclaves/acm.yaml << EOF
certificate_arn: "$ACM_CERT_ARN"
target:
  Acm:
    path: /run/acm
    owner_uid: 0
    owner_gid: 0
EOF

# =============================================================================
# Create mint directories
# =============================================================================
echo "Creating mint directories..."

mkdir -p /opt/mint/{enclave,parent,logs,secrets}
chown -R ec2-user:ec2-user /opt/mint

# Store configuration
cat > /opt/mint/config.env << EOF
KMS_KEY_ID=$KMS_KEY_ID
AWS_REGION=$AWS_REGION
ACM_CERT_ARN=$ACM_CERT_ARN
ENCLAVE_MEMORY_MIB=$ENCLAVE_MEMORY_MIB
ENCLAVE_CPU_COUNT=$ENCLAVE_CPU_COUNT
DATABASE_URL=postgresql://mintuser:$DB_PASSWORD@localhost:5432/mintdb
EOF

chmod 600 /opt/mint/config.env

# =============================================================================
# Create helper scripts
# =============================================================================

# Script to start enclave
cat > /opt/mint/start-enclave.sh << 'EOF'
#!/bin/bash
set -euo pipefail

source /opt/mint/config.env

# Start vsock services if not running
systemctl start vsock-proxies || true
systemctl start vsock-bridge || true

# Run enclave
nitro-cli run-enclave \
    --enclave-cid 16 \
    --eif-path /opt/mint/enclave/mint.eif \
    --memory $ENCLAVE_MEMORY_MIB \
    --cpu-count $ENCLAVE_CPU_COUNT
EOF

chmod +x /opt/mint/start-enclave.sh

# Script to stop enclave
cat > /opt/mint/stop-enclave.sh << 'EOF'
#!/bin/bash
ENCLAVE_ID=$(nitro-cli describe-enclaves | jq -r '.[0].EnclaveID // empty')
if [[ -n "$ENCLAVE_ID" ]]; then
    nitro-cli terminate-enclave --enclave-id "$ENCLAVE_ID"
fi
EOF

chmod +x /opt/mint/stop-enclave.sh

# Script to view enclave console
cat > /opt/mint/enclave-console.sh << 'EOF'
#!/bin/bash
ENCLAVE_ID=$(nitro-cli describe-enclaves | jq -r '.[0].EnclaveID // empty')
if [[ -n "$ENCLAVE_ID" ]]; then
    nitro-cli console --enclave-id "$ENCLAVE_ID"
else
    echo "No enclave running"
fi
EOF

chmod +x /opt/mint/enclave-console.sh

# =============================================================================
# Finish
# =============================================================================
echo "User data script completed at $(date)"
echo "Instance is ready for enclave deployment"
echo "Next steps:"
echo "  1. Copy EIF to /opt/mint/enclave/mint.eif"
echo "  2. Run /opt/mint/start-enclave.sh"
