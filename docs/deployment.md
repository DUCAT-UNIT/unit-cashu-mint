# Deployment Guide

Step-by-step instructions for deploying the Ducat Mint Server into an AWS Nitro Enclave from scratch. This guide is written for automated agents and assumes no prior state.

## Prerequisites

- AWS account with admin access
- AWS CLI configured (`aws sts get-caller-identity` succeeds)
- Terraform >= 1.0 installed
- Docker running (for enclave image builds)
- An EC2 key pair created in the target region
- A registered domain name (for TLS certificate)
- Node.js 22.4+ and npm installed locally

## Overview

```
Phase 1: Terraform (VPC, EC2, KMS, IAM, ACM)
Phase 2: Parent instance setup (Postgres, vsock proxies, systemd)
Phase 3: Build enclave image (Docker -> EIF, extract PCR0)
Phase 4: Update KMS policy with PCR0
Phase 5: Deploy EIF to EC2
Phase 6: First boot (generate and seal secrets via KMS)
Phase 7: Enable boot services (auto-start on reboot)
Phase 8: Verify
```

---

## Phase 1: Terraform Infrastructure

### 1.1 Initialize Terraform

```bash
cd terraform
terraform init
```

### 1.2 Create a `terraform.tfvars` file

```hcl
aws_region         = "us-east-1"
environment        = "prod"
domain_name        = "mint.yourdomain.com"
instance_type      = "m5.xlarge"
enclave_memory_mib = 4096
enclave_cpu_count  = 2
db_password        = "GENERATE_A_STRONG_PASSWORD"
key_pair_name      = "your-ec2-keypair-name"
admin_cidr_blocks  = ["YOUR_IP/32"]   # for SSH access
enclave_pcr0_hash  = "000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
```

The `enclave_pcr0_hash` is a placeholder. It will be updated in Phase 4 after building the enclave image.

### 1.3 Apply

```bash
terraform plan
terraform apply
```

### 1.4 Record outputs

```bash
terraform output
```

Save these values — you will need them throughout the deployment:

| Output | Used In |
|--------|---------|
| `instance_id` | SSH, SSM commands |
| `public_ip` | SSH, health checks |
| `kms_key_arn` | Enclave config, KMS policy updates |
| `acm_certificate_arn` | Enclave TLS (if using ACM) |
| `ssh_command` | Connecting to instance |
| `acm_validation_records` | DNS setup |

### 1.5 DNS setup

Add these DNS records:

1. **ACM validation**: Add the CNAME records from `acm_validation_records` to your DNS provider. Wait for ACM to show `ISSUED` status:
   ```bash
   aws acm describe-certificate --certificate-arn <ACM_ARN> --query 'Certificate.Status'
   ```

2. **A record**: Point `mint.yourdomain.com` to the `public_ip` output (Elastic IP).

---

## Phase 2: Parent Instance Setup

### 2.1 SSH into the instance

```bash
ssh -i ~/.ssh/your-key.pem ec2-user@<PUBLIC_IP>
```

### 2.2 Verify user data completed

The Terraform `user_data` script runs on first boot. Check it finished:

```bash
cat /var/log/user-data.log | tail -20
# Should end with "User data script completed successfully"
```

If it hasn't run or failed, run the setup manually:

```bash
sudo bash /opt/mint/setup.sh
```

### 2.3 Verify services are installed

```bash
# Nitro CLI
nitro-cli --version

# PostgreSQL
sudo systemctl status postgresql
sudo -u postgres psql -c "SELECT 1;"

# socat
socat -V | head -1

# vsock-proxy
which vsock-proxy
```

### 2.4 Verify PostgreSQL database exists

```bash
sudo -u postgres psql -d mintdb -c "SELECT current_database();"
```

If `mintdb` doesn't exist:

```bash
sudo -u postgres psql <<EOF
CREATE DATABASE mintdb;
CREATE USER mintuser WITH PASSWORD 'YOUR_DB_PASSWORD';
GRANT ALL PRIVILEGES ON DATABASE mintdb TO mintuser;
ALTER DATABASE mintdb OWNER TO mintuser;
EOF
```

### 2.5 Run database migrations

Copy migrations to the instance and run them:

```bash
# From your local machine:
scp -i ~/.ssh/your-key.pem -r migrations/ ec2-user@<PUBLIC_IP>:/tmp/migrations/

# On the instance:
sudo -u postgres psql -d mintdb -f /tmp/migrations/001_initial_schema.sql
sudo -u postgres psql -d mintdb -f /tmp/migrations/002_fix_transaction_id_length.sql
```

Verify:

```bash
sudo -u postgres psql -d mintdb -c "SELECT name FROM migrations ORDER BY id;"
```

### 2.6 Create enclave directories

```bash
sudo mkdir -p /opt/mint-enclave/{secrets,logs}
sudo chown -R ec2-user:ec2-user /opt/mint-enclave
```

---

## Phase 3: Build the Enclave Image

This step builds the Docker image and converts it to a Nitro Enclave Image File (EIF). It must be done on a machine with Docker installed. This can be done locally or on the EC2 instance.

### Option A: Build on EC2 (recommended)

```bash
# On the instance, clone or copy the repo
cd /opt/mint-enclave

# Copy source files (from local machine)
# scp -i ~/.ssh/your-key.pem -r \
#   src/ enclave/ package.json package-lock.json tsconfig.json \
#   ec2-user@<PUBLIC_IP>:/opt/mint-enclave/

# Install dependencies and compile TypeScript
npm ci
npm run build

# Build the enclave image
cd enclave
chmod +x build.sh
./build.sh
```

### Option B: Build locally and upload

```bash
# Local machine
cd enclave
chmod +x build.sh
./build.sh

# Upload EIF to EC2
scp -i ~/.ssh/your-key.pem build/mint-enclave.eif \
  ec2-user@<PUBLIC_IP>:/opt/mint-enclave/mint-enclave.eif
scp -i ~/.ssh/your-key.pem build/measurements.json \
  ec2-user@<PUBLIC_IP>:/opt/mint-enclave/measurements.json
```

### 3.1 Extract PCR0

```bash
PCR0=$(cat /opt/mint-enclave/build/measurements.json | jq -r '.Measurements.PCR0 // .measurements.PCR0')
echo "PCR0: $PCR0"
```

Save this value. You need it for the next phase.

---

## Phase 4: Update KMS Policy with PCR0

The KMS key policy must include the enclave's PCR0 hash so that KMS only decrypts secrets when the request comes from a verified enclave image.

### 4.1 Update from local machine

```bash
# Get the KMS key ID
KMS_KEY_ARN=$(cd terraform && terraform output -raw kms_key_arn)

# Get current policy
aws kms get-key-policy --key-id "$KMS_KEY_ARN" --policy-name default \
  --query Policy --output text > /tmp/kms-policy.json

# Edit /tmp/kms-policy.json:
# Find the "AllowEnclaveDecryptWithAttestation" or "AllowEnclaveRoleAccess" statement
# Replace the PCR0 value with the one from Phase 3
#
# "kms:RecipientAttestation:PCR0": "<PASTE_PCR0_HERE>"

# Apply updated policy
aws kms put-key-policy --key-id "$KMS_KEY_ARN" --policy-name default \
  --policy file:///tmp/kms-policy.json
```

### 4.2 Also update Terraform state

```bash
cd terraform
terraform apply -var enclave_pcr0_hash="$PCR0"
```

This keeps the Terraform state consistent with the deployed policy.

---

## Phase 5: Deploy EIF to EC2

### 5.1 Copy files to the expected locations

On the EC2 instance:

```bash
# EIF file
cp /opt/mint-enclave/build/mint-enclave.eif /opt/mint-enclave/mint-enclave.eif

# Parent scripts
cp parent/send-credentials.sh /opt/mint-enclave/send-credentials.sh
cp parent/send-secrets.sh /opt/mint-enclave/send-secrets.sh
chmod +x /opt/mint-enclave/send-credentials.sh
chmod +x /opt/mint-enclave/send-secrets.sh
```

### 5.2 Install systemd services

```bash
sudo cp parent/systemd/mint-enclave.service /etc/systemd/system/
sudo cp parent/systemd/mint-postgres-proxy.service /etc/systemd/system/
sudo cp parent/systemd/mint-https-proxy.service /etc/systemd/system/
sudo cp parent/systemd/mint-kms-proxy.service /etc/systemd/system/
sudo cp parent/systemd/mint-creds-sender.service /etc/systemd/system/
sudo cp parent/systemd/mint-secrets-sender.service /etc/systemd/system/

sudo systemctl daemon-reload
```

### 5.3 Verify the allocator has enough memory

```bash
cat /etc/nitro_enclaves/allocator.yaml
# memory_mib should be >= 6144 (enclave uses 5500)
# cpu_count should be >= 2
```

If not:

```bash
sudo tee /etc/nitro_enclaves/allocator.yaml <<EOF
---
memory_mib: 6144
cpu_count: 2
EOF
sudo systemctl restart nitro-enclaves-allocator.service
```

---

## Phase 6: First Boot (Generate Secrets)

First boot generates MINT_SEED and ENCRYPTION_KEY inside the enclave using KMS `GenerateDataKey`. The encrypted ciphertexts are sent back to the parent for backup.

### 6.1 Set first boot environment

Edit the enclave service to pass `FIRST_BOOT=true` and the KMS key:

```bash
sudo tee /etc/systemd/system/mint-enclave-firstboot.service <<EOF
[Unit]
Description=Ducat Mint Enclave (First Boot)
After=network.target nitro-enclaves-allocator.service mint-postgres-proxy.service mint-kms-proxy.service
Requires=nitro-enclaves-allocator.service mint-postgres-proxy.service mint-kms-proxy.service

[Service]
Type=oneshot
RemainAfterExit=yes
Environment=FIRST_BOOT=true
Environment=KMS_KEY_ID=<PASTE_KMS_KEY_ARN>
Environment=AWS_REGION=us-east-1
ExecStartPre=/usr/bin/nitro-cli terminate-enclave --all
ExecStart=/usr/bin/nitro-cli run-enclave --enclave-cid 16 --eif-path /opt/mint-enclave/mint-enclave.eif --memory 5500 --cpu-count 2
ExecStartPost=/bin/sleep 15
ExecStop=/usr/bin/nitro-cli terminate-enclave --all
EOF
sudo systemctl daemon-reload
```

**Note:** The `FIRST_BOOT` and `KMS_KEY_ID` environment variables are baked into the EIF at Docker build time via build args. If your `enclave/build.sh` already sets them, the systemd environment lines above are not needed. Check `enclave/Dockerfile` for `ARG KMS_KEY_ID` and `ARG FIRST_BOOT`.

### 6.2 Start proxy services

```bash
sudo systemctl start mint-postgres-proxy.service
sudo systemctl start mint-kms-proxy.service
```

### 6.3 Start the enclave

```bash
sudo systemctl start mint-enclave.service
# Or if using the firstboot service:
sudo systemctl start mint-enclave-firstboot.service
```

Wait 15 seconds for the enclave to boot.

### 6.4 Send credentials to the enclave

```bash
/opt/mint-enclave/send-credentials.sh
```

This retrieves AWS credentials from IMDSv2 and sends them to the enclave via vsock port 9000. The script retries up to 12 times with 5-second intervals.

### 6.5 Receive encrypted secrets from enclave

On first boot, the enclave generates secrets and sends the encrypted ciphertexts to the parent via vsock port 9001:

```bash
# Listen for secrets from enclave
mkdir -p /opt/mint-enclave/secrets
socat -u VSOCK-LISTEN:9001 CREATE:/opt/mint-enclave/secrets/encrypted_secrets.json
```

Or if the enclave already sent them during boot, check if the file exists:

```bash
cat /opt/mint-enclave/secrets/encrypted_secrets.json
```

The file should contain JSON with `MINT_SEED` and `ENCRYPTION_KEY` fields (both base64-encoded ciphertexts).

### 6.6 Back up the encrypted secrets

**This file is critical.** Without it, you cannot recover the mint's signing keys on a new enclave instance.

```bash
# Copy to S3
aws s3 cp /opt/mint-enclave/secrets/encrypted_secrets.json \
  s3://YOUR_BACKUP_BUCKET/mint-secrets/encrypted_secrets.json \
  --sse aws:kms

# Also keep a local backup
scp -i ~/.ssh/your-key.pem \
  ec2-user@<PUBLIC_IP>:/opt/mint-enclave/secrets/encrypted_secrets.json \
  ./encrypted_secrets_backup.json
```

### 6.7 Verify the enclave is running

```bash
nitro-cli describe-enclaves
# State should be "RUNNING"

# Check HTTPS endpoint (from the EC2 instance)
curl -sk https://localhost:8443/health
# Should return: {"status":"ok","timestamp":...,"version":"0.1.0"}

curl -sk https://localhost:8443/v1/info
# Should return mint info with name, version, supported NUTs
```

### 6.8 Stop the first-boot enclave

```bash
sudo systemctl stop mint-enclave.service
# Or:
sudo nitro-cli terminate-enclave --all
```

---

## Phase 7: Enable Boot Services

Now configure all services to start automatically on reboot using the normal boot flow (decrypt existing secrets, not generate new ones).

### 7.1 Enable systemd services

```bash
sudo systemctl enable nitro-enclaves-allocator.service
sudo systemctl enable mint-postgres-proxy.service
sudo systemctl enable mint-kms-proxy.service
sudo systemctl enable mint-enclave.service
sudo systemctl enable mint-https-proxy.service
sudo systemctl enable mint-creds-sender.service
sudo systemctl enable mint-secrets-sender.service
```

### 7.2 Start all services

```bash
sudo systemctl start mint-postgres-proxy.service
sudo systemctl start mint-kms-proxy.service
sudo systemctl start mint-enclave.service
# Wait 15s for enclave boot
sleep 15
sudo systemctl start mint-creds-sender.service
sudo systemctl start mint-secrets-sender.service
sudo systemctl start mint-https-proxy.service
```

### 7.3 Verify the service chain

```bash
# All should show "active"
for svc in nitro-enclaves-allocator mint-postgres-proxy mint-kms-proxy mint-enclave mint-https-proxy mint-creds-sender mint-secrets-sender; do
  echo "$svc: $(systemctl is-active $svc)"
done
```

### 7.4 Test a full reboot

```bash
sudo reboot
```

After the instance comes back (1-2 minutes):

```bash
ssh -i ~/.ssh/your-key.pem ec2-user@<PUBLIC_IP>

nitro-cli describe-enclaves
# State: RUNNING

curl -sk https://localhost:8443/health
# {"status":"ok"}
```

---

## Phase 8: Verify End-to-End

### 8.1 From the EC2 instance

```bash
BASE="https://localhost:8443"

echo "=== Health ==="
curl -sk $BASE/health

echo "=== Info ==="
curl -sk $BASE/v1/info

echo "=== Keysets ==="
curl -sk $BASE/v1/keysets

echo "=== Keys ==="
curl -sk $BASE/v1/keys

echo "=== Create mint quote (sat) ==="
curl -sk -X POST $BASE/v1/mint/quote/unit \
  -H 'Content-Type: application/json' \
  -d '{"amount": 1000, "unit": "sat", "rune_id": "840000:3"}'

echo "=== Swap (empty, should error) ==="
curl -sk -X POST $BASE/v1/swap \
  -H 'Content-Type: application/json' \
  -d '{"inputs": [], "outputs": []}'

echo "=== Check state (empty, should error) ==="
curl -sk -X POST $BASE/v1/checkstate \
  -H 'Content-Type: application/json' \
  -d '{"Ys": []}'
```

Expected results:
- Health: `{"status":"ok"}`
- Info: Returns mint name, version, supported NUTs
- Keysets: Empty `[]` until first mint quote triggers keyset creation
- Keys: Empty `[]` until first keyset exists
- Mint quote: Returns a quote with a taproot deposit address
- Swap: `{"error":"Invalid inputs"}`
- Check state: `{"error":"Invalid request: Ys array is empty"}`

### 8.2 From the internet

```bash
curl -sk https://mint.yourdomain.com/health
curl -sk https://mint.yourdomain.com/v1/info
```

If using self-signed certs, `-k` is required. With ACM, it should work without `-k`.

### 8.3 Verify keyset creation

After the first mint quote, a keyset is created:

```bash
curl -sk https://localhost:8443/v1/keysets
# {"keysets":[{"id":"...","unit":"sat","active":true}]}

curl -sk https://localhost:8443/v1/keys
# Returns all public keys for denominations 1 through 8388608
```

---

## Updating the Enclave

When you change application code and need to redeploy:

### 1. Build new EIF

```bash
npm run build
cd enclave && ./build.sh
```

### 2. Extract new PCR0

```bash
PCR0=$(cat build/measurements.json | jq -r '.Measurements.PCR0 // .measurements.PCR0')
echo "New PCR0: $PCR0"
```

### 3. Update KMS policy

```bash
# Edit kms-policy.json with new PCR0
aws kms put-key-policy --key-id <KMS_KEY_ARN> --policy-name default \
  --policy file://kms-policy.json
```

### 4. Deploy new EIF

```bash
scp -i ~/.ssh/your-key.pem build/mint-enclave.eif \
  ec2-user@<PUBLIC_IP>:/opt/mint-enclave/mint-enclave.eif
```

### 5. Restart enclave

```bash
ssh -i ~/.ssh/your-key.pem ec2-user@<PUBLIC_IP>
sudo nitro-cli terminate-enclave --all
sudo systemctl start mint-enclave.service
sleep 15
sudo systemctl start mint-creds-sender.service
sudo systemctl start mint-secrets-sender.service
```

### 6. Verify

```bash
curl -sk https://localhost:8443/health
```

**Important:** Every code change produces a new PCR0. You must update the KMS policy before restarting, or the enclave will fail to decrypt secrets.

---

## Troubleshooting

### Enclave won't start

```bash
# Check allocator
sudo systemctl status nitro-enclaves-allocator
cat /etc/nitro_enclaves/allocator.yaml

# Check available memory (must have enough for enclave + OS)
free -m

# Check enclave logs (if debug mode)
nitro-cli console --enclave-id $(nitro-cli describe-enclaves | jq -r '.[0].EnclaveID')
```

### KMS decrypt fails

```bash
# Verify PCR0 matches
nitro-cli describe-enclaves | jq '.[0].Measurements.PCR0'

# Compare with KMS policy
aws kms get-key-policy --key-id <KMS_KEY_ARN> --policy-name default \
  --query Policy --output text | jq '.Statement[] | select(.Sid | contains("Enclave"))'
```

If PCR0 doesn't match, update the KMS policy (see "Updating the Enclave" above).

### Enclave can't reach PostgreSQL

```bash
# Check postgres proxy is running
sudo systemctl status mint-postgres-proxy

# Check PostgreSQL is listening
sudo -u postgres psql -c "SELECT 1;"

# Check vsock-proxy
ps aux | grep vsock-proxy
```

### Secrets not received by enclave

```bash
# Check credentials sender
sudo systemctl status mint-creds-sender
journalctl -u mint-creds-sender --no-pager -n 20

# Check secrets sender
sudo systemctl status mint-secrets-sender
journalctl -u mint-secrets-sender --no-pager -n 20

# Verify encrypted secrets file exists
ls -la /opt/mint-enclave/secrets/encrypted_secrets.json
cat /opt/mint-enclave/secrets/encrypted_secrets.json | jq .
```

### TLS certificate issues

```bash
# Self-signed: the enclave generates one automatically if ACM is not configured
# ACM: check certificate status
aws acm describe-certificate --certificate-arn <ACM_ARN> --query 'Certificate.Status'

# Check nginx is running inside enclave (from enclave console)
nitro-cli console --enclave-id <ID>
# Look for: "nginx: [emerg]" or "nginx started"
```

### View enclave console output

```bash
ENCLAVE_ID=$(nitro-cli describe-enclaves | jq -r '.[0].EnclaveID')
nitro-cli console --enclave-id "$ENCLAVE_ID"
```

This streams stdout/stderr from inside the enclave. Look for `[unseal]` log lines during boot.

---

## Port Reference

| Port | Protocol | Location | Purpose |
|------|----------|----------|---------|
| 443 | TCP | Parent (inbound) | Public HTTPS (TCP passthrough to enclave) |
| 8443 | TCP/TLS | Enclave (Nginx) | TLS termination |
| 3338 | HTTP | Enclave (Node.js) | Mint server (internal) |
| 5432 | TCP | Parent (Postgres) | Database |
| 8000 | TCP | Parent (KMS proxy) | KMS API access |
| 9000 | vsock | Enclave (inbound) | AWS credentials receiver |
| 9001 | vsock | Parent (inbound) | Encrypted secrets receiver (first boot) |
| 9002 | vsock | Enclave (inbound) | Encrypted secrets receiver (normal boot) |

## vsock CIDs

| CID | Entity |
|-----|--------|
| 3 | Parent EC2 instance |
| 16 | Nitro Enclave |

---

## Security Checklist

- [ ] KMS key policy locked to specific PCR0 hash
- [ ] Encrypted secrets backed up to S3 (KMS-encrypted)
- [ ] PostgreSQL listening on localhost only (no remote access)
- [ ] EC2 security group allows only 443 and SSH from admin IPs
- [ ] HAProxy/socat runs TCP passthrough only (no TLS termination on parent)
- [ ] `FIRST_BOOT=true` is not set in production systemd services
- [ ] `MINT_CONFIRMATIONS` >= 6 for mainnet
- [ ] `MELT_CONFIRMATIONS` >= 6 for mainnet
- [ ] Database password is strong and unique
- [ ] Encrypted secrets file has mode 600
- [ ] Enclave console is not in debug mode for production
