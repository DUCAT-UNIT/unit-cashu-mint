# Private Operations Evidence

This repository documents how the mint is operated without publishing runtime
secrets, plaintext key material, or private infrastructure evidence.

The public repo should contain procedures, verifier behavior, and non-sensitive
release summaries. The private operations archive should contain the sensitive
evidence needed by maintainers to prove what happened during a deployment.

## Public Versus Private

| Category | Public repo | Private operations archive |
|---|---|---|
| Release process | Workflow names, high-level steps, verifier checks | Full run records, operator notes, approval records |
| Container image | Image digest and non-sensitive attestation summary | Artifact Registry path, provenance records, deploy approval trail |
| Deployment attestation | Predicate type, verifier scope, public run link when safe | Attestation JSON, markdown summary, checksum, artifact URL |
| Secrets | Secret names only when needed for setup docs | Secret payload versions, rotation notes, emergency access notes |
| Key management | KMS purpose, IAM shape, verifier checks | Exact key resource inventory, access review notes |
| Database | Private Cloud SQL posture and migration process | Instance inventory, backup/restore evidence, incident notes |
| Audit logs | What log classes are enabled and retained | Audit bucket/object references, alert reviews, access reviews |
| Admin access | `ADMIN_ENABLED`/`ADMIN_TOKEN` behavior | Token rotation record and who has access |

Do not commit private archive contents to this repository.

## Deployment And Attestation Flow

A deploy-relevant push to `main` triggers the GCP Confidential Space release
workflow when paths such as `src/**`, `migrations/**`, `terraform/gcp/**`,
`gcp-confidential-space/**`, package files, or the release workflow change.

If repository and environment configuration are present, the workflow:

1. Builds the Confidential Space workload image.
2. Records and attests the image digest.
3. Plans and applies Terraform with that pinned digest.
4. Restarts the Confidential Space VM.
5. Health-checks the public mint endpoint.
6. Generates `gcp-confidential-space-deployment-attestation.json`.
7. Signs that predicate with GitHub Artifact Attestations.
8. Uploads the JSON, markdown summary, and checksum as workflow artifacts.

If required configuration is missing, preflight exits successfully and records
that deployment was skipped without touching GCP.

## Private Release Ledger

For every production or dev release, maintainers should update the private
ledger with:

- commit SHA and branch;
- GitHub Actions run URL;
- environment name;
- container image digest;
- Terraform apply result;
- deployment attestation artifact URL;
- attestation JSON SHA-256;
- public health-check result;
- audit-monitoring status;
- operator who reviewed the run.

The public `docs/release-evidence.md` can reference the non-sensitive run URL
and summarize the current posture. It must not include Secret Manager payloads,
database URLs, admin bearer tokens, service account keys, or raw audit log
exports.

## Review Checklist

Before considering a release privately evidenced, verify:

- the release workflow ran from `main` or an approved manual dispatch;
- preflight reported configured release inputs;
- the deployed image digest matches the attested digest;
- the deployment attestation result is `pass`;
- the attestation JSON checksum is recorded privately;
- Secret Manager and app KMS access are bound to the attested digest principal;
- the VM service account does not have direct secret or app KMS decrypt access;
- Cloud SQL remains private-IP only;
- audit archive and alerting resources are present when required;
- no secret values appear in GitHub logs or committed files.

