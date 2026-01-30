# Ducat Mint Server

A Cashu ecash mint backed by Bitcoin and Bitcoin Runes, deployed inside an AWS Nitro Enclave. The parent instance never sees plaintext HTTP traffic, private keys, or seed material.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green?logo=node.js)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## What is UNIT?

[UNIT](https://docs.ducatprotocol.com/unit/philosophy) is a Bitcoin-backed CDP stablecoin maintaining a soft peg to USD at 1.01-1.04 UNIT per dollar. Unlike algorithmic stablecoins, UNIT uses **exogenous collateralization** (135-160% BTC backing) to ensure stability during market stress.

This mint enables **privacy-preserving transfers** of UNIT tokens through Cashu ecash, combining the stability of Bitcoin-backed stablecoins with the privacy of blind signatures.

## Features

- **Cashu Protocol**: Full NUT-00 through NUT-11 implementation
- **Multi-Unit**: Bitcoin (BTC) + Bitcoin Runes (sat) with pluggable backend architecture
- **Nitro Enclave**: TLS termination, key derivation, and signing all happen inside the enclave
- **KMS Attestation**: MINT_SEED and ENCRYPTION_KEY sealed to enclave PCR0 via AWS KMS
- **Privacy-Preserving**: Blind signatures (BDHKE) ensure unlinkability
- **P2PK Support**: Public key locks, timelocks, multisig (NUT-11)

## Architecture

```
                          Internet
                             |
                         TCP :443
                             |
┌────────────────────────────┼─────────────────────────────────────────────┐
│                       EC2 Instance (Parent)                              │
│                            |                                             │
│                     ┌──────┴──────┐                                      │
│                     │   HAProxy   │  TCP passthrough (Layer 4, no TLS)   │
│                     │  *:443 →    │                                      │
│                     │  vsock:8443 │                                      │
│                     └──────┬──────┘                                      │
│                            | vsock                                       │
│   ┌────────────────────────┼────────────────────────────────────────┐   │
│   │                  NITRO ENCLAVE (CID 16)                         │   │
│   │                        |                                        │   │
│   │                ┌───────┴───────┐                                │   │
│   │                │     Nginx     │  TLS termination (self-signed  │   │
│   │                │   :8443 SSL   │  or ACM PKCS#11)               │   │
│   │                │       ↓       │                                │   │
│   │                │  127.0.0.1    │                                │   │
│   │                │    :3338      │                                │   │
│   │                └───────┬───────┘                                │   │
│   │                        |                                        │   │
│   │                ┌───────┴───────┐                                │   │
│   │                │   Node.js     │  Fastify + TypeScript          │   │
│   │                │  Mint Server  │                                │   │
│   │                │               │  MINT_SEED ← KMS attestation   │   │
│   │                │               │  ENCRYPTION_KEY ← KMS          │   │
│   │                │               │  Blind signatures (secp256k1)  │   │
│   │                └───────┬───────┘                                │   │
│   │                        | localhost:5432                          │   │
│   │                        | (vsock tunnel to parent)               │   │
│   └────────────────────────┼────────────────────────────────────────┘   │
│                            | vsock                                       │
│           ┌────────────────┼────────────────────┐                        │
│           │ vsock proxies:                      │                        │
│           │  :5432 → localhost:5432 (Postgres)  │                        │
│           │  :8000 → kms.<region>:443 (KMS)     │                        │
│           └────────────────┬────────────────────┘                        │
│                            |                                             │
│                     ┌──────┴──────┐                                      │
│                     │  PostgreSQL  │                                      │
│                     │  localhost   │                                      │
│                     │    :5432     │                                      │
│                     └─────────────┘                                      │
└──────────────────────────────────────────────────────────────────────────┘
```

**Security properties:**
- Parent sees only encrypted TLS bytes (TCP passthrough, no termination)
- MINT_SEED and ENCRYPTION_KEY are sealed to the enclave via KMS attestation (PCR0-locked)
- Private signing keys never leave enclave memory; stored encrypted (AES-256-CBC) in Postgres
- No network interface inside the enclave; all I/O goes through vsock

## Project Structure

```
mint-server/
├── src/
│   ├── api/routes/              # Cashu NUT endpoint handlers
│   │   ├── mint.ts              # NUT-04: mint quotes & token issuance
│   │   ├── melt.ts              # NUT-05: melt quotes & withdrawal
│   │   ├── swap.ts              # NUT-03: token swap
│   │   ├── keys.ts              # NUT-01/02: keyset info
│   │   ├── checkstate.ts        # NUT-07: proof state
│   │   └── dashboard.ts         # monitoring
│   ├── btc/                     # BTC payment backend
│   │   ├── BTCBackend.ts        # IPaymentBackend for BTC unit
│   │   ├── tx-builder.ts        # PSBT construction
│   │   └── types.ts
│   ├── runes/                   # Bitcoin Runes payment backend
│   │   ├── RunesBackend.ts      # IPaymentBackend for sat unit
│   │   ├── UtxoManager.ts       # Rune UTXO tracking
│   │   ├── WalletKeyManager.ts  # HD key derivation
│   │   ├── psbt-builder.ts      # PSBT + runestone construction
│   │   ├── utxo-selection.ts    # Coin selection
│   │   ├── runestone-encoder.ts # Rune edict encoding
│   │   ├── api-client.ts        # Ord + Esplora API clients
│   │   └── types.ts
│   ├── core/
│   │   ├── crypto/
│   │   │   ├── KeyManager.ts        # Keyset lifecycle, deterministic derivation, AES encryption
│   │   │   ├── MintCrypto.ts        # Blind signatures (sign, verify, hash-to-curve)
│   │   │   └── SchnorrSignature.ts
│   │   ├── models/
│   │   │   ├── Quote.ts             # MintQuote, MeltQuote
│   │   │   ├── Keyset.ts            # Keyset with encrypted private keys
│   │   │   └── Proof.ts
│   │   ├── payment/
│   │   │   ├── BackendRegistry.ts   # Routes requests by unit to backend
│   │   │   └── types.ts             # IPaymentBackend interface
│   │   └── services/
│   │       ├── MintService.ts       # Quote creation, token issuance
│   │       ├── SwapService.ts       # Token swap with P2PK support
│   │       ├── MeltService.ts       # Withdrawal execution
│   │       └── CheckStateService.ts # Proof state queries
│   ├── database/
│   │   ├── db.ts                    # pg Pool, query(), transaction()
│   │   └── repositories/
│   │       ├── KeysetRepository.ts  # Keyset CRUD (upsert on conflict)
│   │       ├── QuoteRepository.ts   # Mint/melt quote persistence
│   │       └── ProofRepository.ts   # Double-spend tracking
│   ├── services/
│   │   ├── BackgroundTaskManager.ts # Orchestrates background services
│   │   ├── DepositMonitor.ts        # Polls for deposits every 30s
│   │   └── UtxoSyncService.ts       # Syncs rune UTXOs every 5min
│   ├── di/
│   │   └── container.ts             # Dependency injection container
│   ├── config/
│   │   └── env.ts                   # Zod-validated environment config
│   ├── types/
│   │   └── cashu.ts                 # Cashu protocol types
│   ├── utils/
│   │   ├── errors.ts                # NUT-00 error classes
│   │   └── logger.ts                # Pino logger
│   ├── app.ts                       # Fastify setup, CORS, error handler
│   └── server.ts                    # Entrypoint: DB check → preload keysets → start
├── enclave/
│   ├── Dockerfile                   # Multi-stage: kmstool-enclave-cli + Node.js + Nginx
│   ├── entrypoint.sh                # Boot: loopback → vsock → unseal → nginx → node
│   ├── nginx.conf                   # TLS termination, rate limiting, security headers
│   ├── unseal-secrets.sh            # KMS genkey (first boot) / decrypt (normal boot)
│   ├── vsock-adapter.sh             # socat bridges: localhost ports <-> parent vsock
│   └── build.sh
├── parent/
│   ├── systemd/
│   │   ├── mint-enclave.service         # nitro-cli run-enclave
│   │   ├── mint-postgres-proxy.service  # vsock:5432 <-> localhost:5432
│   │   ├── mint-https-proxy.service     # HAProxy TCP passthrough
│   │   ├── mint-kms-proxy.service       # vsock:8000 <-> kms.<region>:443
│   │   ├── mint-creds-sender.service    # Send AWS credentials to enclave
│   │   └── mint-secrets-sender.service  # Send encrypted secrets to enclave
│   ├── haproxy.cfg                  # Layer 4 TCP: *:443 → vsock:16:8443
│   ├── send-credentials.sh          # IMDSv2 → vsock (retry-enabled)
│   ├── send-secrets.sh              # Encrypted secrets → vsock (retry-enabled)
│   └── setup*.sh                    # Installation scripts
├── terraform/
│   ├── main.tf                      # EC2, VPC, KMS, IAM, ACM, security groups
│   ├── github-oidc.tf               # CI/CD via GitHub Actions OIDC
│   └── backend.tf                   # Terraform state backend
├── migrations/
│   ├── 001_initial_schema.sql       # keysets, mint_quotes, melt_quotes, proofs, mint_utxos
│   └── 002_fix_transaction_id_length.sql
└── tests/
    ├── unit/                        # 319 tests across 23 files
    │   ├── crypto/                  # KeyManager, MintCrypto
    │   ├── btc/                     # BTCBackend, tx-builder
    │   ├── runes/                   # RunesBackend, UTXO selection, PSBT, runestone
    │   ├── services/                # MintService, DepositMonitor, BackgroundTasks
    │   ├── database/                # db, repositories
    │   └── ...
    └── integration/                 # API routes, end-to-end mint flow
```

## Cashu Protocol (NUT Compliance)

Implements the [Cashu](https://github.com/cashubtc/nuts) ecash protocol:

| NUT | Description | Status |
|-----|-------------|--------|
| 00 | Cryptography & proof format | Implemented |
| 01 | Mint public keys | Implemented |
| 02 | Keysets & mint info | Implemented |
| 03 | Swap (split/merge tokens) | Implemented |
| 04 | Mint tokens (deposit) | Implemented |
| 05 | Melt tokens (withdraw) | Implemented |
| 07 | Token state check | Implemented |
| 09 | Restore | Implemented |
| 10 | Spending conditions | Implemented |
| 11 | P2PK (Pay-to-Public-Key) | Implemented |
| 12 | DLEQ proofs | Not yet |

## API Endpoints

```
GET  /health                        Health check
GET  /v1/info                       Mint info (name, supported NUTs, limits)
GET  /v1/keys                       All active keysets with public keys
GET  /v1/keys/:keyset_id            Public keys for a specific keyset
GET  /v1/keysets                    List keysets (id, unit, active status)

POST /v1/mint/quote/unit            Create deposit quote (returns address)
GET  /v1/mint/quote/unit/:quote_id  Check deposit quote status
POST /v1/mint/tokens/unit           Claim tokens for paid deposit

POST /v1/swap                       Swap proofs for new tokens

POST /v1/melt/quote/unit            Create withdrawal quote
GET  /v1/melt/quote/unit/:quote_id  Check withdrawal quote status
POST /v1/melt/tokens/unit           Execute withdrawal with proofs

POST /v1/check                      Check proof state (spent/unspent)
POST /v1/restore                    Restore tokens
```

## Multi-Unit Support

The mint supports multiple Bitcoin-based units through a pluggable backend architecture:

| Unit | Backend | Deposit Method | Withdrawal Method |
|------|---------|----------------|-------------------|
| `sat` | RunesBackend | Rune transfer to derived taproot address | PSBT with runestone edict |
| `btc` | BTCBackend | BTC transfer to P2WPKH address | Standard BTC transaction |

Backends implement the `IPaymentBackend` interface and are registered at startup based on `SUPPORTED_UNITS`. The `BackendRegistry` routes operations by unit at runtime.

```
BackendRegistry
  ├── 'sat' → RunesBackend (Rune deposits/withdrawals via Ord + Esplora)
  └── 'btc' → BTCBackend   (BTC deposits/withdrawals via Esplora)
```

## Cryptography

### Key Derivation

```
MINT_SEED (32 bytes, from KMS)
    |
    +--> SHA256(MINT_SEED || rune_id || unit) = keyset_seed
              |
              +--> For each denomination d in [1, 2, 4, 8 ... 8388608]:
                      k_d = SHA256(keyset_seed || d)     # private key
                      K_d = k_d * G                       # public key (secp256k1)
```

Keyset IDs are deterministic: same MINT_SEED + rune_id + unit always produces the same keyset. Private keys are encrypted at rest with AES-256-CBC using ENCRYPTION_KEY before storage in Postgres.

### Blind Signatures (BDHKE)

```
Client:                          Mint:
  secret = random(32)
  Y = hash_to_curve(secret)
  r = random_scalar()
  B_ = Y + r*G  ───────────>   C_ = k * B_
                 <───────────   return {id, amount, C_}
  C = C_ - r*K
    = k*Y                       (valid token)

Verification:
  C == k * hash_to_curve(secret)
```

### Double-Spend Prevention

Each proof is tracked by `Y = hash_to_curve(secret)`. State transitions: `UNSPENT -> PENDING -> SPENT`. The `proofs` table has a unique index on `secret` as a backup check.

## Database Schema

Five tables in PostgreSQL:

| Table | Purpose |
|-------|---------|
| `keysets` | Keyset metadata, encrypted private keys, public keys |
| `mint_quotes` | Deposit quotes: UNPAID -> PAID -> ISSUED |
| `melt_quotes` | Withdrawal quotes: UNPAID -> PENDING -> PAID |
| `proofs` | Spent proof tracking with state machine |
| `mint_utxos` | Rune UTXO tracking for reserve management |

## Dependency Injection

```
initializeContainer()
  │
  ├── Repositories
  │   ├── KeysetRepository
  │   ├── QuoteRepository
  │   └── ProofRepository
  │
  ├── Crypto Layer
  │   ├── KeyManager(keysetRepo)
  │   └── MintCrypto(keyManager)
  │
  ├── Payment Backends
  │   ├── RunesBackend [if 'sat' enabled]
  │   ├── BTCBackend   [if 'btc' enabled]
  │   └── BackendRegistry
  │
  ├── Core Services
  │   ├── MintService(mintCrypto, quoteRepo, backendRegistry, keyManager)
  │   ├── SwapService(mintCrypto, proofRepo)
  │   ├── MeltService(mintCrypto, quoteRepo, proofRepo, backendRegistry)
  │   └── CheckStateService(mintCrypto, proofRepo)
  │
  └── Background Tasks
      └── BackgroundTaskManager(backendRegistry, quoteRepo)
          ├── DepositMonitor    (polls every 30s)
          └── UtxoSyncService   (syncs every 5min)
```

## Enclave Security Model

### Boot Sequence

1. `ip link set lo up` and verify `/dev/vsock`
2. Start vsock adapters (Postgres, HTTPS, KMS tunnels)
3. Receive AWS credentials from parent via vsock port 9000
4. **First boot**: Generate data keys via `kmstool-enclave-cli genkey`, store encrypted ciphertext on parent
5. **Normal boot**: Receive encrypted ciphertext from parent, decrypt via `kmstool-enclave-cli decrypt` with NSM attestation
6. Generate or load self-signed TLS cert (or ACM PKCS#11 in production)
7. Start Nginx (TLS on :8443 -> Node.js on :3338)
8. Start Node.js mint server

### KMS Attestation Policy

```json
{
  "Condition": {
    "StringEqualsIgnoreCase": {
      "kms:RecipientAttestation:PCR0": "<enclave-image-sha384>"
    }
  }
}
```

KMS will only decrypt the sealed MINT_SEED and ENCRYPTION_KEY when the request originates from an enclave whose code hash (PCR0) matches the policy. Any change to the enclave image produces a different PCR0, requiring a policy update.

### What the Parent Cannot Access

- Plaintext HTTP requests/responses (sees only TLS ciphertext)
- MINT_SEED or ENCRYPTION_KEY (sealed to enclave PCR0)
- Decrypted private signing keys (exist only in enclave memory)
- Token secrets or proof data in transit

## Development

### Prerequisites

- Node.js 20+
- PostgreSQL 15+
- A `.env` file (see `src/config/env.ts` for the full schema)

### Setup

```bash
npm install
npm run migrate
npm run dev          # tsx watch mode
```

### Build

```bash
npm run build        # tsc -> dist/
npm start            # node dist/server.js
```

### Test

```bash
npm test             # vitest (watch mode)
npx vitest run       # single run (319 tests)
npm run test:coverage
```

### Lint & Format

```bash
npm run lint         # eslint
npm run format       # prettier
```

## Enclave Deployment

### Build the Enclave Image

```bash
cd enclave
docker build -t mint-enclave:latest .
nitro-cli build-enclave --docker-uri mint-enclave:latest --output-file mint-enclave.eif
nitro-cli describe-eif --eif-path mint-enclave.eif   # get PCR0 for KMS policy
```

### Update KMS Policy

After each build, update the KMS key policy with the new PCR0:

```bash
aws kms put-key-policy --key-id <key-id> --policy-name default --policy file://kms-policy.json
```

### Run the Enclave

```bash
nitro-cli run-enclave --enclave-cid 16 --eif-path mint-enclave.eif --memory 5500 --cpu-count 2
```

### Parent Services (systemd)

```bash
sudo systemctl enable --now mint-postgres-proxy
sudo systemctl enable --now mint-kms-proxy
sudo systemctl enable --now mint-enclave
sudo systemctl enable --now mint-https-proxy
sudo systemctl enable --now mint-creds-sender
sudo systemctl enable --now mint-secrets-sender
```

### Verify

```bash
nitro-cli describe-enclaves                          # State: RUNNING
curl -sk https://localhost:8443/health               # {"status":"ok"}
curl -sk https://localhost:8443/v1/info              # mint info
curl -sk https://localhost:8443/v1/keysets            # active keysets
```

## Infrastructure (Terraform)

```bash
cd terraform
terraform init
terraform plan -var="domain_name=mint.example.com"
terraform apply
```

Creates: VPC, EC2 (m5.xlarge with enclaves enabled), KMS key with attestation policy, IAM role, ACM certificate, security groups.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `MINT_SEED` | Yes | 32-byte hex seed for key derivation |
| `ENCRYPTION_KEY` | Yes | 32-byte hex key for AES-256-CBC |
| `MINT_PUBKEY` | Yes | Mint public key |
| `JWT_SECRET` | Yes | JWT signing secret |
| `ESPLORA_URL` | Yes | Esplora API endpoint |
| `ORD_URL` | Yes | Ord API endpoint |
| `MEMPOOL_URL` | Yes | Mempool API endpoint |
| `NETWORK` | No | `mainnet\|testnet\|signet\|regtest\|mutinynet` (default: testnet) |
| `SUPPORTED_UNITS` | No | Comma-separated: `sat`, `btc`, or `sat,btc` (default: sat) |
| `SUPPORTED_RUNES` | If sat | Rune ID, e.g. `840000:3` |
| `MINT_TAPROOT_ADDRESS` | If sat | Taproot address for rune deposits |
| `MINT_TAPROOT_PUBKEY` | If sat | 32-byte x-only taproot pubkey |
| `MINT_SEGWIT_ADDRESS` | If sat | SegWit address for fee collection |
| `MINT_BTC_ADDRESS` | If btc | P2WPKH address for BTC deposits |
| `MINT_BTC_PUBKEY` | If btc | Public key for BTC signing |
| `PORT` | No | Server port (default: 3000) |
| `HOST` | No | Bind address (default: 0.0.0.0) |
| `ENCLAVE_MODE` | No | `true` for enclave-specific behavior |
| `LOG_LEVEL` | No | `debug\|info\|warn\|error` (default: info) |
| `REDIS_URL` | No | Redis connection string |
| `MIN_MINT_AMOUNT` | No | Minimum mint amount (default: 100) |
| `MAX_MINT_AMOUNT` | No | Maximum mint amount (default: 100000000) |

## Security

This is custodial software. Users must trust the mint operator.

- **Generate secure seeds**: Use `openssl rand -hex 32` for MINT_SEED and ENCRYPTION_KEY
- **Deploy in enclave**: The Nitro Enclave ensures the parent instance cannot access plaintext keys or traffic
- **Restrict CORS**: Set `CORS_ORIGINS` to allowed origins only
- **Monitor reserves**: Ensure issued tokens never exceed UTXO balance
- **Backup database**: Regular PostgreSQL backups are critical for key recovery

Report security issues to: security@ducatprotocol.com

## License

MIT License - see [LICENSE](LICENSE) file.

---

**Built for the Bitcoin & Cashu ecosystem**

[Report Issues](https://github.com/DUCAT-UNIT/cashu-mint/issues)
