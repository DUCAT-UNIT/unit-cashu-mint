# Dev Release Evidence

This page captures the current dev deployment evidence for maintainers and
reviewers. It is intentionally factual: workflow links, endpoint behavior, and
what the attestations claim.

## Current Dev Mint

- Endpoint: `https://dev-cashu-mint.ducatprotocol.com`
- Mint info: `https://dev-cashu-mint.ducatprotocol.com/v1/info`
- GCP project: `ducat-dev`
- Deployment mode: GCP Confidential Space
- Runtime secret: Secret Manager `ducat-mint-env`
- Runtime database: private Cloud SQL PostgreSQL
- Key encryption: app-level Cloud KMS for newly written keyset private keys
- Secret at-rest encryption: Secret Manager CMEK
- TLS: Caddy terminates TLS inside the Confidential Space workload container

## Protocol And Wallet Compatibility

The branch has CI coverage for the compatibility paths maintainers asked for:

- `@cashu/cashu-ts` is upgraded to `4.0.0`.
- Cashu Interop runs cashu-ts, CDK CLI, and Nutshell wallet flows against this
  mint.
- Cashu Upstream Compatibility runs upstream cashu-ts integration and CDK happy
  path checks.
- The live dev mint advertises UNIT on-chain, BTC on-chain as `sat`, and dev
  `bolt11` support for browser-wallet/CDK/cashu-ts interoperability.
- The production Lightning path is implemented through LNbits.

The fake `bolt11` backend is intentionally gated by `ALLOW_FAKE_LIGHTNING=true`
when the container image runs with `NODE_ENV=production`. It lets cashu-ts, CDK,
Nutshell, and browser wallets exercise real NUT-04/NUT-05 HTTP flows without
putting real Lightning funds behind the dev mint. Live Lightning settlement
should use `LIGHTNING_BACKEND=lnbits` with `LNBITS_URL`,
`LNBITS_INVOICE_KEY`, and `LNBITS_ADMIN_KEY`.

## Main Checks

Current main release commit:

```text
024023901d074ceb2fd9badeaf2a8eede7aa7367
```

Green checks on that commit:

- CI: `https://github.com/DUCAT-UNIT/unit-cashu-mint/actions/runs/25253476678`
- Cashu Interop: `https://github.com/DUCAT-UNIT/unit-cashu-mint/actions/runs/25253476654`
- Cashu Upstream Compatibility: `https://github.com/DUCAT-UNIT/unit-cashu-mint/actions/runs/25253476667`
- GCP Confidential Space Release: `https://github.com/DUCAT-UNIT/unit-cashu-mint/actions/runs/25253476653`

Latest dev redeploy after metadata/audit updates:

```text
https://github.com/DUCAT-UNIT/unit-cashu-mint/actions/runs/25254088629
```

## Secure Update Flow

The GCP release workflow performs the enclave-style update without exposing mint
secrets to CI:

1. Build the Confidential Space workload image.
2. Record and attest the image digest.
3. Update Terraform with the new pinned digest.
4. Rotate the Workload Identity condition plus Secret Manager and Cloud KMS IAM
   bindings to the new digest-bound Confidential Space principal.
5. Restart the Confidential Space VM.
6. Health-check the public mint endpoint.
7. Generate and sign a deployment security attestation predicate.

CI receives resource names and IAM metadata. It does not read the Secret Manager
payload and does not call Cloud KMS encrypt or decrypt.

## Auditability

Audit monitoring is enabled for the dev project:

- Admin Activity logs for IAM, Workload Identity, KMS, Secret Manager, VM, and
  Cloud SQL changes are archived to a dedicated Cloud Storage bucket.
- KMS and Secret Manager Data Access audit logs are enabled.
- The archive bucket has 365-day retention configured.
- Retention locking is intentionally disabled in dev because locking a Cloud
  Storage retention policy is irreversible for the configured period.

The deployment attestation verifier checks that the audit archive exists and,
when Data Access logging is enabled, that Cloud KMS and Secret Manager data
access audit configs are present on the project.
