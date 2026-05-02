# Ducat Mint Server

Cashu ecash mint for BTC and UNIT Runes, deployed through GCP Confidential
Space.

The security target is simple: mint secrets and app-level Cloud KMS decrypt
capability are available only to the pinned, attested container image. The VM
service account should not directly read the Secret Manager payload or decrypt
app key material.

## What Runs

- Fastify/TypeScript Cashu mint.
- BTC on-chain ecash as `onchain` / `sat`.
- UNIT Runes ecash as `onchain` / `unit`.
- Optional Lightning as `bolt11` / `sat` through LNbits.
- Private Cloud SQL for mint state.
- Secret Manager plus app-level Cloud KMS for runtime secrets and keyset
  encryption.

## Deploys From Main

`main` pushes always run CI.

Deploy-relevant `main` pushes also run
`.github/workflows/gcp-confidential-space-release.yml`. Relevant paths include
`src/**`, `migrations/**`, `terraform/gcp/**`, `gcp-confidential-space/**`,
package files, and the release workflow itself.

When release preflight is configured, the workflow:

1. Builds the Confidential Space workload image.
2. Attests the image digest.
3. Applies Terraform with the pinned digest.
4. Restarts the Confidential Space VM.
5. Health-checks the mint.
6. Generates and signs the deployment security attestation.
7. Uploads the attestation JSON, markdown summary, and checksum.

If required GitHub environment variables or secrets are missing, preflight skips
deployment without touching GCP.

## Where The Attestation Is

To find the evidence that CI did not reveal KMS keys or read secrets:

1. Open GitHub Actions for this repo.
2. Open the successful **GCP Confidential Space Release** run for the deployed
   commit.
3. Open the run summary and artifact list.
4. Download artifact `gcp-confidential-space-deployment-attestation`.
5. Inspect:
   - `gcp-confidential-space-deployment-attestation.md`
   - `gcp-confidential-space-deployment-attestation.json`
   - `gcp-confidential-space-deployment-attestation.json.sha256`

The markdown summary has a **Key Handling Claims** section. The JSON has the
same evidence under `claims`. The important claims are:

```json
{
  "verifierDidNotReadSecretPayloads": true,
  "verifierDidNotRequestKmsDecrypt": true,
  "verifierDidNotRequestKmsEncrypt": true,
  "kmsKeyMaterialWasNotExportedToCi": true,
  "appKmsAccessIsBoundToAttestedImageDigest": true,
  "secretManagerAccessIsBoundToAttestedImageDigest": true,
  "runtimeServiceAccountHasNoDirectAppKmsAccess": true,
  "runtimeServiceAccountHasNoDirectSecretAccess": true
}
```

Also check:

- `result` is `pass`;
- `subject.imageDigest` matches the deployed image digest;
- the SHA-256 file matches the downloaded JSON;
- the workflow step **Attest deployment security predicate** completed
  successfully.

Private release evidence should keep the full attestation artifact, checksum,
audit review notes, and operator review record. Do not commit secret payloads,
database URLs, admin bearer tokens, service account keys, or raw audit exports.

## Local Development

```bash
npm install
cp .env.example .env
docker-compose up -d
npm run migrate
npm run dev
```

Useful checks:

```bash
npm run lint
npm run build
npm test
```

Manual diagnostics live in `scripts/dev/`. They are not part of CI, deploy, or
release evidence.

## Repo Map

```text
src/                     mint application
migrations/              SQL migrations used by npm run migrate
gcp-confidential-space/  Confidential Space container files
terraform/gcp/           GCP infrastructure
scripts/interop/         wallet compatibility flows
scripts/dev/             manual diagnostics and one-off helpers
docs/                    detailed security and deployment notes
tests/                   unit and integration tests
```

## Detailed Docs

- `docs/security.md`
- `docs/gcp-confidential-deployment.md`
- `docs/release-evidence.md`
- `docs/private-operations.md`
- `docs/archive/` for historical notes only
