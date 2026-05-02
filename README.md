# Ducat Mint Server

A Cashu ecash mint backed by Bitcoin and Bitcoin Runes, deployed on GCP
Confidential Space.

**Property the Confidential Space deployment gives you:** mint secrets and
Cloud KMS decrypt capability are only available to the pinned, attested
container image. The VM service account does not have direct access to the
mint Secret Manager payload or app-level Cloud KMS key.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22.4+-green?logo=node.js)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## What This Is

- **Cashu protocol** - full NUT-00 through NUT-11 plus supported quote
  signatures and payment-method extensions.
- **Multi-method / multi-unit** - BTC on-chain (`onchain`/`sat`), UNIT Runes
  (`onchain`/`unit`), and optional Lightning (`bolt11`/`sat` via LNbits)
  behind a single mint.
- **GCP Confidential Space deployment** - the production path runs the mint as
  an attested container with image-digest-bound Secret Manager and Cloud KMS
  access.
- **Cloud KMS keyset encryption** - newly written mint keyset private keys are
  encrypted through Cloud KMS in GCP modes.

[UNIT](https://docs.ducatprotocol.com/unit/philosophy) is a Bitcoin-backed CDP
stablecoin. This mint enables privacy-preserving transfers of UNIT tokens using
Cashu blind signatures.

## Architecture At A Glance

```text
Internet :443
    |
    v
GCP Confidential Space VM
    |
    |-- Caddy :443              TLS for the mint endpoint
    |-- Node.js :3338           Fastify Cashu mint
    |-- Secret Manager fetch    allowed only after attestation
    |-- Cloud KMS encrypt/decrypt
    |                           allowed only to the expected image digest
    |
    v
Private Cloud SQL PostgreSQL
```

Terraform binds Secret Manager access and app-level Cloud KMS encrypt/decrypt
to a Workload Identity Federation principal scoped to the expected Confidential
Space image digest. The VM runtime service account can launch the workload, but
it cannot directly read the mint secret or decrypt app key material.

## Where To Read Next

- **Security model:** [`docs/security.md`](./docs/security.md)
- **GCP deployment:** [`docs/gcp-confidential-deployment.md`](./docs/gcp-confidential-deployment.md)
- **Private operations evidence:** [`docs/private-operations.md`](./docs/private-operations.md)
- **Local development:** [`CONTRIBUTING.md`](./CONTRIBUTING.md)
- **Historical notes:** [`docs/archive/`](./docs/archive/)

## Quick Start

```bash
git clone <repo> && cd mint-server
npm install
cp .env.example .env
docker-compose up -d
npm run dev
npm test
```

Full dev loop and conventions are in [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Live Dev Mint

- **Endpoint:** https://dev-cashu-mint.ducatprotocol.com
- **GCP project:** `ducat-dev`
- **Deployment mode:** Confidential Space

The release workflow builds a new container image, deploys that pinned digest
through Terraform, restarts the Confidential Space VM, verifies live GCP state,
and signs a deployment security attestation for the same digest.

## Project Layout

```text
src/                     mint application (TypeScript, Fastify)
gcp-confidential-space/  Confidential Space container entrypoint and Caddy config
terraform/gcp/           GCP Confidential VM and Confidential Space infrastructure
scripts/                 dev, build, deploy, and attestation helpers
docs/                    security, deployment, private evidence, and archived notes
tests/                   unit, integration, and compatibility coverage
```

## Cashu Protocol Coverage

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

## Security Model

The key security claim is tied to the GCP release path:

1. GitHub Actions builds a container image and records the digest.
2. Terraform grants Secret Manager and Cloud KMS access only to a Confidential
   Space attestation principal for that exact digest.
3. The verifier checks live GCP state, including the VM, Workload Identity
   provider condition, Secret Manager IAM, Cloud KMS IAM, private Cloud SQL,
   and audit monitoring resources.
4. The workflow signs a deployment attestation predicate for the digest it
   actually deployed and verified.

Full trust model, update flow, audit monitoring, and known gaps are in
[`docs/security.md`](./docs/security.md).

The repo documents the public process and non-sensitive release summaries. Full
deployment evidence, including attestation JSON, checksums, audit review notes,
and operator records, is kept in the private operations archive described in
[`docs/private-operations.md`](./docs/private-operations.md).

## License

MIT - see [LICENSE](./LICENSE).
