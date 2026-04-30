# Ducat Mint - Nitro Enclave Deployment

## Security Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           INTERNET                                          │
│                              │                                              │
│                         TCP :443 (TLS encrypted)                            │
│                              │                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                        EC2 PARENT INSTANCE                                  │
│                                                                             │
│   ┌─────────────────┐                                                       │
│   │ TCP Passthrough │  socat TCP:443 → vsock:16:8443                       │
│   │ (NO TLS TERM)   │  Parent sees ONLY encrypted bytes                    │
│   └────────┬────────┘                                                       │
│            │ vsock                                                          │
├────────────┼────────────────────────────────────────────────────────────────┤
│            │              NITRO ENCLAVE (CID 16)                            │
│            ▼                                                                │
│   ┌─────────────────┐                                                       │
│   │ Nginx (TLS)     │  TLS termination inside enclave                      │
│   │ :8443 → :3338   │  Certificate key via ACM PKCS#11                     │
│   └────────┬────────┘                                                       │
│            │                                                                │
│            ▼                                                                │
│   ┌─────────────────┐                                                       │
│   │ Node.js Mint    │  MINT_SEED, ENCRYPTION_KEY in memory only            │
│   │ :3338           │  Keys unsealed via KMS attestation                   │
│   └────────┬────────┘                                                       │
│            │                                                                │
├────────────┼────────────────────────────────────────────────────────────────┤
│            │ vsock                                                          │
│            ▼                                                                │
│   ┌─────────────────┐                                                       │
│   │ vsock-proxy     │  vsock:5432 → localhost:5432 (Postgres)              │
│   │                 │  vsock:443  → kms.amazonaws.com:443                  │
│   └─────────────────┘                                                       │
│                                                                             │
│   ┌─────────────────┐                                                       │
│   │ PostgreSQL      │  localhost:5432                                       │
│   │                 │  Data at rest (not secrets)                          │
│   └─────────────────┘                                                       │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Security Properties

1. **TLS Termination Inside Enclave**: Parent instance NEVER sees plaintext HTTP. All TLS is terminated by Nginx running inside the enclave.

2. **KMS-Sealed Secrets**: `MINT_SEED` and `ENCRYPTION_KEY` are:
   - Generated inside the enclave on first boot
   - Encrypted with KMS before leaving the enclave
   - Only decryptable by an enclave with matching PCR0 hash
   - Never stored in plaintext anywhere

3. **Attestation-Gated Decryption**: KMS key policy requires valid Nitro Enclave attestation document with matching PCR0. Anyone with root access to the parent instance CANNOT decrypt the secrets.

4. **ACM Certificate Isolation**: TLS private key managed by ACM for Nitro Enclaves, isolated inside the enclave via PKCS#11.

## Deployment Steps

### 1. Parent Instance Setup

```bash
# Install Nitro Enclaves CLI
sudo amazon-linux-extras install aws-nitro-enclaves-cli -y
sudo yum install aws-nitro-enclaves-cli-devel -y

# Enable enclave allocator
sudo systemctl enable nitro-enclaves-allocator
sudo systemctl start nitro-enclaves-allocator

# Configure allocator (edit /etc/nitro_enclaves/allocator.yaml)
# memory_mib: 4096
# cpu_count: 2
```

### 2. PostgreSQL Setup

```bash
sudo yum install postgresql15-server -y
sudo postgresql-setup --initdb
sudo systemctl enable postgresql
sudo systemctl start postgresql

# Create database
sudo -u postgres psql -c "CREATE DATABASE mintdb;"
sudo -u postgres psql -c "CREATE USER mintuser WITH PASSWORD 'your-password';"
sudo -u postgres psql -c "GRANT ALL ON DATABASE mintdb TO mintuser;"
```

### 3. Build Enclave Image

```bash
cd mint-server
./enclave/build.sh
```

This outputs:
- `build/mint-enclave.eif` - The enclave image
- `build/measurements.json` - PCR0, PCR1, PCR2 hashes

### 4. Create KMS Key with Attestation Policy

```bash
# Update ACCOUNT_ID in parent/kms-policy.json
# Update ENCLAVE_PCR0_HASH with the PCR0 from build

./parent/setup-kms.sh
```

The KMS key policy allows:
- `kms:Encrypt` - For first boot secret generation
- `kms:Decrypt` - ONLY with valid attestation matching PCR0

### 5. Setup ACM Certificate (Production TLS)

For production, use AWS Certificate Manager with Nitro Enclaves:

```bash
# 1. Request a certificate in ACM Console
#    - Domain: mint.yourdomain.com
#    - Validation: DNS (add CNAME to Route53)

# 2. Enable the certificate for Nitro Enclaves
#    - In ACM Console, select certificate
#    - Actions → "Associate with Nitro Enclaves"

# 3. Install ACM for Nitro Enclaves on parent
sudo amazon-linux-extras install aws-nitro-enclaves-acm -y

# 4. Configure /etc/nitro_enclaves/acm.yaml
cat << 'EOF' | sudo tee /etc/nitro_enclaves/acm.yaml
acm:
  certificate_arn: "arn:aws:acm:us-east-1:ACCOUNT:certificate/CERT-ID"
  # Token name must match nginx.conf ssl_certificate_key
  token_label: "acm"
EOF

# 5. Start ACM agent (runs on parent, provisions to enclave via vsock)
sudo systemctl enable nitro-enclaves-acm
sudo systemctl start nitro-enclaves-acm
```

For **development**, the enclave generates self-signed certificates automatically.

**Note**: ACM for Nitro Enclaves uses PKCS#11 to isolate the private key inside the enclave. The parent never sees the private key.

### 6. Setup Parent Proxies and Systemd Services

```bash
# Install systemd services
cd parent
sudo ./install-services.sh

# This installs:
# - mint-postgres-proxy.service  - vsock proxy for PostgreSQL
# - mint-external-proxy.service  - vsock proxy for external HTTPS (Ord/Esplora)
# - mint-enclave.service         - The enclave itself
# - mint-https-proxy.service     - TCP passthrough for inbound HTTPS

# Start the services
sudo systemctl start mint-postgres-proxy
sudo systemctl start mint-external-proxy
sudo systemctl start mint-enclave
sudo systemctl start mint-https-proxy

# Check status
sudo systemctl status mint-enclave
```

The vsock-proxy allowlist is configured in `/etc/nitro_enclaves/vsock-proxy.yaml`:
- PostgreSQL (localhost:5432)
- Bitcoin APIs (mempool.space, ordinals.com, testnet.ordinals.com)
- KMS endpoints (kms.*.amazonaws.com)

### 7. Deploy Enclave

```bash
# Copy EIF to parent
scp build/mint-enclave.eif ec2-user@<parent-ip>:/opt/enclave/

# SSH to parent
ssh ec2-user@<parent-ip>

# First boot (generates and seals new secrets)
./parent/run-enclave.sh --first-boot --debug

# After secrets are generated and saved, normal boot:
./parent/run-enclave.sh
```

### 8. Verify

```bash
# Test HTTPS (parent cannot see plaintext)
curl -k https://localhost/health
curl -k https://localhost/v1/info

# Verify from tcpdump - should see only TLS records
sudo tcpdump -i any port 443 -X
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `KMS_KEY_ID` | KMS key ARN for secret encryption | Yes (prod) |
| `ACM_CERT_ARN` | ACM certificate ARN | Yes (prod) |
| `AWS_REGION` | AWS region | Yes |
| `DATABASE_URL` | PostgreSQL connection string | Yes |
| `FIRST_BOOT` | Set to "true" for initial key generation | First boot only |
| `MINT_SEED` | (Dev only) Hardcoded seed | No |
| `ENCRYPTION_KEY` | (Dev only) Hardcoded encryption key | No |

## Updating the Enclave

When you rebuild the enclave, the PCR0 hash changes. You must:

1. Build new EIF: `./enclave/build.sh`
2. Update KMS policy with new PCR0: `./parent/setup-kms.sh`
3. Deploy new EIF: `./parent/run-enclave.sh`

The existing encrypted secrets will still work because they were encrypted with the KMS key (not the enclave image). Only the decryption attestation check uses PCR0.

## Troubleshooting

### Enclave won't start
```bash
# Check allocator
sudo systemctl status nitro-enclaves-allocator

# Check available resources
nitro-cli describe-enclaves
```

### KMS decrypt fails
```bash
# Verify PCR0 in KMS policy matches enclave
nitro-cli describe-eif --eif-path /opt/enclave/mint-enclave.eif
```

### TLS certificate issues
```bash
# Check ACM agent logs inside enclave (debug mode)
nitro-cli console --enclave-id <id>
```

### Database connection fails
```bash
# Check postgres proxy
sudo systemctl status mint-postgres-proxy

# Test connection from parent
psql -h 127.0.0.1 -U mintuser -d mintdb
```

## Known Limitations

### External HTTPS APIs

The enclave cannot resolve DNS because it has no network interface. External API calls (Ord, Esplora, Mempool) require one of these solutions:

1. **HTTP Proxy on Parent** (Recommended)
   ```bash
   # Install tinyproxy on parent
   sudo yum install tinyproxy -y
   # Configure to listen on vsock-accessible port
   # Set HTTPS_PROXY in enclave environment
   ```

2. **Sidecar API Service**
   Run a lightweight service on the parent that proxies API requests for the enclave.

3. **Pre-resolved IPs** (Not recommended)
   Hardcode IP addresses in /etc/hosts inside the Docker image.

For development, the enclave will show "fetch failed" errors for external APIs but the core mint functionality (minting/melting with pre-funded addresses) works.

### Memory Requirements

The enclave requires ~5.5GB RAM. Ensure your EC2 instance type has sufficient memory after allocating for the enclave:
- Instance needs: Host OS + Enclave memory
- Recommended: m5.xlarge (16GB) or larger
