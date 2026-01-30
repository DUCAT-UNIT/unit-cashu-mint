# AWS Nitro Enclaves Integration Plan

## Overview

Integrate the Ducat Mint Server with AWS Nitro Enclaves to provide hardware-level isolation for cryptographic operations, protecting the mint's private keys from the host system.

## Why Nitro Enclaves?

1. **Key Protection**: Mint private keys (MINT_SEED) never leave the enclave
2. **Attestation**: Cryptographic proof that the correct code is running
3. **Isolation**: Even root on the host cannot access enclave memory
4. **Compliance**: Meets high-security requirements for financial operations

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      EC2 Instance (Host)                     │
│                                                              │
│  ┌────────────────────┐     ┌─────────────────────────────┐ │
│  │   Parent App       │     │      Nitro Enclave          │ │
│  │   (Fastify API)    │────▶│                             │ │
│  │                    │     │  ┌───────────────────────┐  │ │
│  │  - HTTP endpoints  │VSOCK│  │   Signing Service     │  │ │
│  │  - Quote mgmt      │────▶│  │   - MINT_SEED         │  │ │
│  │  - DB operations   │     │  │   - Blind signatures  │  │ │
│  │  - UTXO tracking   │◀────│  │   - Key derivation    │  │ │
│  │                    │     │  └───────────────────────┘  │ │
│  └────────────────────┘     │                             │ │
│           │                 │  ┌───────────────────────┐  │ │
│           │                 │  │   KMS Integration     │  │ │
│           ▼                 │  │   - Seed decryption   │  │ │
│  ┌────────────────────┐     │  │   - Attestation       │  │ │
│  │   PostgreSQL       │     │  └───────────────────────┘  │ │
│  │   Redis            │     └─────────────────────────────┘ │
│  └────────────────────┘                                     │
└─────────────────────────────────────────────────────────────┘
```

## Phase 1: Enclave Application (1-2 weeks)

### 1.1 Create Enclave Signing Service

Minimal Rust application that runs inside the enclave:

```
enclave/
├── Cargo.toml
├── src/
│   ├── main.rs           # Enclave entry point
│   ├── vsock.rs          # VSOCK communication
│   ├── crypto.rs         # Blind signature operations
│   ├── kms.rs            # AWS KMS for seed decryption
│   └── attestation.rs    # Attestation document handling
└── Dockerfile.enclave
```

**Enclave responsibilities:**
- Hold MINT_SEED in memory (decrypted via KMS)
- Perform blind signature operations
- Derive keyset keys
- Generate attestation documents

**Why Rust?**
- Minimal attack surface
- No runtime/GC (smaller enclave image)
- Memory safety guarantees
- Fast cryptographic operations

### 1.2 VSOCK Protocol

Define request/response protocol between host and enclave:

```typescript
// Host → Enclave requests
interface SignRequest {
  type: 'sign'
  blindedMessages: Array<{
    B_: string      // Blinded point (hex)
    amount: number
    keysetId: string
  }>
}

interface DeriveKeyRequest {
  type: 'derive_key'
  keysetId: string
  amount: number
}

interface AttestationRequest {
  type: 'attestation'
  nonce: string
}

// Enclave → Host responses
interface SignResponse {
  signatures: Array<{
    C_: string      // Blind signature (hex)
    id: string
    amount: number
  }>
}
```

### 1.3 KMS Integration

Use AWS KMS with enclave attestation policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::ACCOUNT:role/MintEnclaveRole" },
      "Action": "kms:Decrypt",
      "Resource": "*",
      "Condition": {
        "StringEqualsIgnoreCase": {
          "kms:RecipientAttestation:PCR0": "EXPECTED_PCR0_HASH"
        }
      }
    }
  ]
}
```

The encrypted MINT_SEED can only be decrypted by the specific enclave code.

## Phase 2: Host Application Refactor (1 week)

### 2.1 Extract Crypto Operations

Create a `CryptoProvider` interface:

```typescript
// src/core/crypto/CryptoProvider.ts
interface CryptoProvider {
  signBlindedMessages(messages: BlindedMessage[]): Promise<BlindSignature[]>
  deriveKeysetKeys(keysetId: string): Promise<KeysetKeys>
  getAttestation(nonce: string): Promise<AttestationDocument>
}

// Local implementation (for dev/testing)
class LocalCryptoProvider implements CryptoProvider { ... }

// Enclave implementation (for production)
class EnclaveCryptoProvider implements CryptoProvider {
  private vsockClient: VsockClient

  async signBlindedMessages(messages) {
    return this.vsockClient.send({ type: 'sign', blindedMessages: messages })
  }
}
```

### 2.2 Files to Modify

| File | Changes |
|------|---------|
| `src/core/crypto/MintCrypto.ts` | Use CryptoProvider interface |
| `src/core/crypto/KeyManager.ts` | Delegate key derivation to provider |
| `src/di/container.ts` | Inject appropriate CryptoProvider |
| `src/config/env.ts` | Add ENCLAVE_ENABLED, VSOCK_CID, VSOCK_PORT |

### 2.3 New Files

```
src/
├── enclave/
│   ├── VsockClient.ts        # VSOCK communication
│   ├── EnclaveCryptoProvider.ts
│   └── types.ts              # Protocol types
```

## Phase 3: Infrastructure (1 week)

### 3.1 Terraform/CDK Resources

```hcl
# EC2 instance with Nitro Enclave support
resource "aws_instance" "mint" {
  instance_type = "m5.xlarge"  # Enclave-capable

  enclave_options {
    enabled = true
  }

  # Allocate memory for enclave
  # Enclave needs ~256MB, leave rest for host
}

# KMS key for seed encryption
resource "aws_kms_key" "mint_seed" {
  description = "Ducat Mint Seed Encryption"
  policy      = data.aws_iam_policy_document.enclave_kms.json
}

# Secrets Manager for encrypted seed
resource "aws_secretsmanager_secret" "mint_seed" {
  name       = "ducat/mint/seed"
  kms_key_id = aws_kms_key.mint_seed.id
}
```

### 3.2 Docker Configuration

**Host Dockerfile:**
```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY dist/ ./dist/
CMD ["node", "dist/server.js"]
```

**Enclave Dockerfile:**
```dockerfile
FROM amazonlinux:2
RUN yum install -y aws-nitro-enclaves-cli
COPY target/release/mint-enclave /app/
CMD ["/app/mint-enclave"]
```

### 3.3 Enclave Image Build

```bash
# Build enclave image
nitro-cli build-enclave \
  --docker-uri mint-enclave:latest \
  --output-file mint-enclave.eif

# Run enclave
nitro-cli run-enclave \
  --enclave-cid 16 \
  --eif-path mint-enclave.eif \
  --memory 256 \
  --cpu-count 2
```

## Phase 4: Deployment & Operations (1 week)

### 4.1 Deployment Pipeline

```yaml
# .github/workflows/deploy.yml
jobs:
  build-enclave:
    runs-on: ubuntu-latest
    steps:
      - name: Build Rust enclave
        run: cargo build --release
      - name: Build EIF
        run: nitro-cli build-enclave ...
      - name: Upload to S3
        run: aws s3 cp mint-enclave.eif s3://bucket/

  deploy-host:
    needs: build-enclave
    steps:
      - name: Build host image
        run: docker build -t mint-host .
      - name: Push to ECR
        run: docker push ...
      - name: Deploy to EC2
        run: ...
```

### 4.2 Monitoring

```typescript
// Health check endpoint
app.get('/health', async () => ({
  status: 'ok',
  enclave: await cryptoProvider.healthCheck(),
  attestation: await cryptoProvider.getAttestation(nonce)
}))
```

### 4.3 Key Rotation

1. Generate new MINT_SEED
2. Encrypt with KMS
3. Store in Secrets Manager
4. Restart enclave (picks up new seed)
5. Generate new keysets with new derivation

## Implementation Order

| Week | Tasks |
|------|-------|
| 1 | Create Rust enclave application skeleton, VSOCK protocol |
| 2 | Implement blind signature in enclave, KMS integration |
| 3 | Refactor host app with CryptoProvider interface |
| 4 | Infrastructure setup, testing, deployment pipeline |

## Security Considerations

1. **PCR Validation**: Lock KMS policy to specific enclave code hash
2. **Attestation Freshness**: Include timestamp/nonce in attestation
3. **VSOCK Security**: Only enclave can listen on VSOCK
4. **Audit Logging**: Log all signing requests (without secrets)
5. **Rate Limiting**: Prevent DoS on enclave

## Testing Strategy

1. **Local Mode**: Use LocalCryptoProvider for dev/testing
2. **Mock Enclave**: Docker container simulating VSOCK for CI
3. **Integration Tests**: Full flow on enclave-enabled EC2
4. **Attestation Verification**: Verify PCR values match expected

## Cost Estimate

| Resource | Monthly Cost |
|----------|--------------|
| m5.xlarge (enclave) | ~$140 |
| KMS key | ~$1 |
| Secrets Manager | ~$0.40 |
| Data transfer | ~$10 |
| **Total** | **~$150/mo** |

## Alternative: Nitro Enclaves vs Other Options

| Option | Pros | Cons |
|--------|------|------|
| **Nitro Enclaves** | AWS-native, attestation, isolated | AWS-only |
| Intel SGX | Cross-cloud | Complex, vulnerabilities |
| HSM (CloudHSM) | FIPS certified | Expensive (~$1.5k/mo) |
| Software-only | Simple | No hardware isolation |

**Recommendation**: Nitro Enclaves provides the best balance of security, cost, and complexity for this use case.

## Next Steps

1. Set up Nitro-enabled EC2 instance for development
2. Create minimal Rust enclave that can do secp256k1 operations
3. Test VSOCK communication between host and enclave
4. Integrate with existing mint codebase
