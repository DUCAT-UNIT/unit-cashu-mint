# Security model

This mint runs inside an AWS Nitro Enclave. The goal: **the operator of the
EC2 instance cannot see the mint's signing keys**, and any code change to the
enclave is publicly verifiable.

## Trust boundaries

| Component | Trusted with secrets? | Notes |
|---|---|---|
| Operator (us) | No | We can deploy code, change infra, read logs — but not extract keys |
| Parent EC2 instance | No | Holds sealed (encrypted) blob on disk. Cannot decrypt. Acts as a dumb pipe |
| Nitro Enclave | Yes | Isolated VM, no disk, no network, no SSH. Only place plaintext keys exist |
| AWS KMS | Yes (key custody) | Holds the master key in HSM. Only releases it to an enclave whose PCR0 matches policy |
| AWS Nitro hardware | Yes (attestation root) | Signs the attestation document. Forging it = breaking AWS silicon |

## How the keys are protected

The mint's signing keys are **sealed** — encrypted by KMS such that only an
enclave with a specific code fingerprint (`PCR0`) can ask KMS to decrypt them.

- **PCR0** = SHA-384 of the enclave image (`.eif`). Reproducible from source.
- **KMS policy** ([`parent/kms-policy.json`](../parent/kms-policy.json)) gates
  `kms:Decrypt` on `kms:RecipientAttestation:PCR0` matching the allowed value.
- **TLS terminates inside the enclave** ([`enclave/nginx.conf`](../enclave/nginx.conf)).
  Cert private key lives in ACM for Nitro Enclaves via PKCS#11 — never reaches the parent.

## Boot flow

```
Internet :443
    ↓ (TCP passthrough, parent never decrypts)
Parent EC2 → vsock → Enclave
                       ↓
                     nginx (TLS terminates here)
                       ↓
                     Node.js mint :3338
                       ↓
                     KMS Decrypt (gated on PCR0 attestation)
                       ↓
                     plaintext keys in enclave RAM only
```

## Updating the enclave without exposing the key

The KMS key never leaves KMS. Updates change the *guest list*, not the lock.

1. Build new enclave deterministically. Read its PCR0 (`nitro-cli describe-eif`).
2. `aws kms put-key-policy` — add the new PCR0 alongside the old.
3. Roll the enclave (stop old, start new). New enclave attests, KMS unseals into it.
4. `aws kms put-key-policy` again — remove the old PCR0.

The plaintext keys only ever live in enclave RAM. No human, no automated
pipeline, no AWS operator sees them at any point in the rotation.

## Proof artifacts (the three signed receipts)

Anyone reviewing a deployment can verify these independently:

1. **Reproducible build.** Same source commit + Dockerfile → same PCR0.
   Anyone can rebuild and check.
2. **Nitro attestation.** Each KMS call carries a document signed by AWS's
   hardware root, asserting "I am PCR0 = X."
3. **CloudTrail.** Every `kms:Decrypt` and `kms:PutKeyPolicy` event is logged
   and AWS-signed, with the attesting PCR0 and request ID — but never the
   plaintext.

Chain of custody: commit → build → PCR0 → attestation → KMS policy → CloudTrail.

## Current state

- **Live PCR0:** `d064dbadba90a0f4e2fa8a534e8485f0b470f9e5a666bc6355d1b96f1f8dd3fd65baa2cc7418293169742d04791a60a2`
- **KMS key alias:** `alias/ducat-mint-enclave`
- **KMS policy:** single-PCR0 (no rotation list yet — see "Known gaps")

## Known gaps

Being upfront about what isn't covered yet:

### 1. Rotation policy is single-valued
[`parent/kms-policy.json`](../parent/kms-policy.json) currently allows exactly
one PCR0. To rotate cleanly without downtime, this should accept a list:

```json
"ForAnyValue:StringEqualsIgnoreCase": {
  "kms:RecipientAttestation:PCR0": ["OLD_PCR0", "NEW_PCR0"]
}
```

The bootstrap script ([`parent/setup-kms.sh`](../parent/setup-kms.sh)) needs an
`add-pcr` / `prune-pcr` mode to support this.

### 2. Database is outside the enclave
Postgres holds quotes, proofs, keysets in plaintext on the parent host.

- **Spent proofs** are bearer tokens — leakage is acceptable; privacy comes
  from blind signatures, not row-hiding.
- **Mint quotes pre-payment** are the soft spot. Anyone with DB write access
  could delete a quote, mark one paid, or front-run by swapping recipient
  blinded outputs before signing.

Mitigations (not yet implemented): seal the DB credential via KMS so only the
enclave can connect; or wrap sensitive row payloads with a KMS-sealed
data-encryption key held in the enclave.

### 3. No public transparency log
CloudTrail is append-only and AWS-signed, but private to the account. To make
KMS activity verifiable by outsiders we'd ship CloudTrail to an Object-Lock'd
S3 bucket and periodically publish Merkle roots somewhere public (Git, Sigstore
Rekor, etc.).

### 4. No SSM agent reachable on the parent
The parent EC2 currently doesn't report to SSM, so out-of-band inspection
requires SSH or the live HTTP endpoint. Worth restoring for ops.

## What we built vs. what AWS provides

The security primitives are all AWS. We did the wiring.

| Provided by AWS | Built by us |
|---|---|
| Nitro Enclaves (isolation, attestation) | KMS policy ([kms-policy.json](../parent/kms-policy.json)) |
| KMS attestation conditions | vsock proxy plumbing (parent ↔ enclave) |
| ACM for Nitro Enclaves (TLS cert in PKCS#11) | nginx config inside enclave |
| CloudTrail (signed audit log) | Systemd supervision, boot scripts |
|  | Mint code that seals/unseals via KMS |
