# Ducat Mint Server

A Cashu ecash mint backed by Bitcoin and Bitcoin Runes, running inside an AWS Nitro Enclave.

**Property the enclave gives you:** the operator of the EC2 instance cannot see plaintext TLS traffic, mint signing keys, or seed material. Updates to the mint code are publicly verifiable via the enclave's PCR0 fingerprint.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22.4+-green?logo=node.js)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## What this is

- **Cashu protocol** — full NUT-00 through NUT-11 (blind signatures, P2PK, multisig, timelocks).
- **Multi-method / multi-unit** — BTC on-chain (`onchain`/`sat`), UNIT Runes (`onchain`/`unit`), and optional Lightning (`bolt11`/`sat` via LNbits) behind a single mint.
- **Nitro Enclave deployment** — TLS termination, key derivation, and signing all happen inside the enclave; the parent EC2 host is treated as untrusted.
- **KMS-sealed secrets** — `MINT_SEED` and `ENCRYPTION_KEY` are sealed by AWS KMS to a specific enclave fingerprint (PCR0). A different image cannot unseal them.

[UNIT](https://docs.ducatprotocol.com/unit/philosophy) is a Bitcoin-backed CDP stablecoin. This mint enables privacy-preserving transfers of UNIT tokens using Cashu blind signatures.

## Architecture at a glance

```
Internet :443
    │ (TCP passthrough — parent never decrypts)
    ▼
Parent EC2  ──vsock──►  Nitro Enclave
                            │
                            ├── nginx :8443  (TLS terminates here)
                            ├── Node.js :3338 (Fastify mint)
                            └── KMS Decrypt  (gated on PCR0 attestation)
                                  │
                                  └── plaintext keys live in enclave RAM only
```

Postgres runs on the parent and is reached via vsock. Sensitive operations are signed inside the enclave; the DB stores ciphertext for keys (AES-256-CBC) and plaintext for spent-proof bookkeeping.

## Where to read next

- **Reviewing this for security/architecture?**
  → [`docs/architecture.md`](./docs/architecture.md), then [`docs/security.md`](./docs/security.md).
- **Running it locally?**
  → [`CONTRIBUTING.md`](./CONTRIBUTING.md).
- **Deploying it on AWS?**
  → [`docs/deployment.md`](./docs/deployment.md) and [`docs/enclave-deployment.md`](./docs/enclave-deployment.md).
- **Deploying it on GCP?**
  → [`docs/gcp-confidential-deployment.md`](./docs/gcp-confidential-deployment.md).
- **The trust-critical files** (read these to verify the security claims yourself):
  - [`parent/kms-policy.json`](./parent/kms-policy.json) — the KMS condition that gates decrypt on PCR0
  - [`enclave/nginx.conf`](./enclave/nginx.conf) — TLS terminates inside the enclave
  - [`.github/workflows/deploy-enclave.yml`](./.github/workflows/deploy-enclave.yml) — how PCR0 is computed and pinned

## Quick start (local)

```bash
git clone <repo> && cd mint-server
npm install
cp .env.example .env
docker-compose up -d        # postgres, regtest bitcoin
npm run dev                 # mint on :3338
npm test
```

Full dev loop and conventions in [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Live mint

- **Endpoint:** https://cashu-mint.ducatprotocol.com
- **Currently authorized PCR0:** `d064dbadba90a0f4e2fa8a534e8485f0b470f9e5a666bc6355d1b96f1f8dd3fd65baa2cc7418293169742d04791a60a2`
- **KMS key alias:** `alias/ducat-mint-enclave`

PCR0 is published to the GitHub Actions run summary on every deploy and to S3 at `pcr0/<commit-sha>.txt`. Anyone with the source commit + Dockerfile can reproduce the same PCR0.

## Project layout

```
src/         mint application (TypeScript, Fastify)
enclave/     enclave-side image build (Dockerfile, nginx, entrypoint)
parent/      parent EC2 scripts, systemd units, KMS policy, vsock proxies
terraform/   AWS and GCP infra
scripts/     dev/ops one-offs
docs/        architecture, security, deployment docs
examples/    sample configs (nginx, env, tfvars)
tests/       unit + integration
```

## Cashu protocol coverage

| NUT | Feature |
|---|---|
| 00 | Cryptography (BDHKE) |
| 01 | Mint public keys |
| 02 | Keysets and fees |
| 03 | Swap tokens |
| 04 | Mint tokens |
| 05 | Melt tokens |
| 06 | Mint info |
| 07 | Token state check |
| 08 | Lightning fees |
| 09 | Restore signatures |
| 10 | Spending conditions (P2PK) |
| 11 | Pay-to-Pubkey (multisig, timelocks) |
| 20 | Signature on mint quote |
| 23 | BOLT11 Lightning method |
| 26 | Draft on-chain BTC method |

## Security model (one-paragraph version)

Three independent guarantees, each from a different party:

1. **AWS Nitro hardware** signs the attestation document — you can't forge PCR0.
2. **AWS KMS** enforces the policy in [`parent/kms-policy.json`](./parent/kms-policy.json) — even AWS operators can't decrypt without a matching attestation.
3. **Reproducible build** ties the source commit to the EIF to PCR0 — so "PCR0 = X" is shorthand for "running exactly this code."

Full trust model, rotation flow, and known gaps in [`docs/security.md`](./docs/security.md).

## License

MIT — see [LICENSE](./LICENSE).
