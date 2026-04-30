# AWS Nitro Enclave Deployment Guide

This guide covers deploying the Ducat Cashu Mint inside an AWS Nitro Enclave for maximum security.

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         EC2 Instance (Parent)                             │
│                                                                           │
│  Internet :443 ──┐                                                        │
│                  │ TCP passthrough (no TLS termination)                   │
│                  ▼                                                        │
│  ┌─────────────────────────────────────┐                                  │
│  │  socat/HAProxy (TCP mode)           │                                  │
│  │  0.0.0.0:443 → vsock:16:8443        │                                  │
│  └─────────────────────────────────────┘                                  │
│                  │ vsock                                                   │
│  ┌───────────────┼─────────────────────────────────────────────────────┐ │
│  │               ▼             NITRO ENCLAVE                            │ │
│  │  ┌─────────────────────────────────────────────────────────────┐    │ │
│  │  │  Nginx (TLS termination via ACM PKCS#11)                    │    │ │
│  │  │  vsock:8443 → http://127.0.0.1:3338                         │    │ │
│  │  └─────────────────────────────────────────────────────────────┘    │ │
│  │               │                                                      │ │
│  │               ▼                                                      │ │
│  │  ┌─────────────────────────────────────────────────────────────┐    │ │
│  │  │  Node.js Mint (TypeScript)                                  │    │ │
│  │  │  - MINT_SEED (unsealed via KMS attestation)                 │    │ │
│  │  │  - ENCRYPTION_KEY (unsealed via KMS attestation)            │    │ │
│  │  └─────────────────────────────────────────────────────────────┘    │ │
│  └───────────────┼─────────────────────────────────────────────────────┘ │
│                  │ vsock                                                   │
│  ┌───────────────┴─────────────────────────────────────────────────────┐ │
│  │  vsock-proxy services:                                               │ │
│  │  - vsock:5432 → localhost:5432 (PostgreSQL)                         │ │
│  │  - vsock:6379 → localhost:6379 (Redis)                              │ │
│  │  - vsock:443  → kms.amazonaws.com:443 (KMS API)                     │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────┘
```

## Security Properties

- **TLS termination inside enclave**: Parent instance sees only encrypted bytes
- **Secrets sealed to enclave**: MINT_SEED and ENCRYPTION_KEY can only be decrypted by the exact enclave image
- **Zero plaintext on parent**: Private keys and HTTP traffic never accessible outside enclave
- **Attestation-based access**: KMS requires valid PCR0 hash before releasing secrets

## Prerequisites

- AWS account with Nitro Enclave support
- Instance type with enclave support (m5.xlarge or larger)
- Domain name with DNS control (for ACM certificate)
- Terraform >= 1.0 installed
- AWS CLI configured

## Deployment Steps

### 1. Infrastructure Setup (Terraform)

```bash
cd terraform

# Copy and edit variables
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your values

# Deploy infrastructure
terraform init
terraform plan
terraform apply
```

This creates:
- VPC with public subnet
- EC2 instance with Nitro Enclave enabled
- KMS key with attestation policy
- ACM certificate
- Security groups
- IAM roles

### 2. DNS Configuration

After Terraform completes:

1. Add the DNS validation records shown in output to validate ACM certificate
2. Create an A record pointing your domain to the EC2 Elastic IP

### 3. Build Enclave Image

On an Amazon Linux 2 instance (can be the deployed EC2):

```bash
# Clone repository
git clone <repo-url> /opt/mint
cd /opt/mint

# Build enclave image
chmod +x enclave/build.sh
./enclave/build.sh

# Note the PCR0 hash from output
```

### 4. Update KMS Policy

Update the KMS key policy with the PCR0 hash from the build:

```bash
# In terraform/terraform.tfvars, update:
enclave_pcr0_hash = "your-pcr0-hash-from-build"

# Apply the update
terraform apply
```

### 5. First Boot (Generate Secrets)

For the initial deployment, secrets need to be generated:

```bash
ssh ec2-user@<your-instance-ip>

# Set first boot flag and start enclave
export FIRST_BOOT=true
/opt/mint/start-enclave.sh
```

This will:
1. Generate new MINT_SEED and ENCRYPTION_KEY inside the enclave
2. Encrypt them with KMS
3. Store the ciphertext for subsequent boots

### 6. Verify Deployment

```bash
# Check enclave status
nitro-cli describe-enclaves

# Test HTTPS endpoint
curl https://your-domain.tld/health

# View enclave console (debug mode only)
/opt/mint/enclave-console.sh
```

## Operations

### Restarting the Enclave

```bash
# Stop
/opt/mint/stop-enclave.sh

# Start
/opt/mint/start-enclave.sh
```

### Viewing Logs

```bash
# Enclave console (if started with --debug-mode)
nitro-cli console --enclave-id $(nitro-cli describe-enclaves | jq -r '.[0].EnclaveID')

# Parent logs
journalctl -u vsock-proxies
journalctl -u vsock-bridge
```

### Updating the Mint

1. Build new EIF with `./enclave/build.sh`
2. Update KMS policy with new PCR0 hash
3. Stop old enclave
4. Copy new EIF to instance
5. Start new enclave

```bash
# On your build machine
./enclave/build.sh
scp build/mint-enclave.eif ec2-user@<host>:/opt/mint/enclave/

# On EC2
/opt/mint/stop-enclave.sh
/opt/mint/start-enclave.sh
```

## Troubleshooting

### Enclave won't start

```bash
# Check allocator config
cat /etc/nitro_enclaves/allocator.yaml

# Restart allocator
sudo systemctl restart nitro-enclaves-allocator

# Check available memory
free -m
```

### KMS decrypt fails

1. Verify PCR0 hash matches KMS policy
2. Check IAM role has kms:Decrypt permission
3. Verify vsock proxy for KMS is running:
   ```bash
   systemctl status vsock-proxies
   ```

### Database connection fails

```bash
# Check PostgreSQL is running
systemctl status postgresql

# Check vsock proxy
systemctl status vsock-proxies

# Test from enclave (via console)
nc -z localhost 5432
```

### TLS certificate issues

```bash
# Check ACM certificate status in AWS Console
# Verify DNS validation records are in place
# Check ACM for Nitro Enclaves service:
systemctl status nitro-enclaves-acm
```

## Cost Estimate

| Resource | Monthly Cost |
|----------|--------------|
| m5.xlarge (on-demand) | ~$140 |
| KMS key | ~$1 |
| ACM certificate | Free |
| Data transfer | ~$10 |
| **Total** | **~$150/mo** |

Use Reserved Instances or Savings Plans for production to reduce costs.

## Security Checklist

- [ ] PCR0 hash in KMS policy matches deployed EIF
- [ ] SSH access restricted to admin IPs only
- [ ] PostgreSQL password is strong and unique
- [ ] ACM certificate is validated and active
- [ ] vsock-proxy allowlist only includes necessary hosts
- [ ] Debug mode disabled in production
- [ ] Regular EIF rebuilds to include security patches
