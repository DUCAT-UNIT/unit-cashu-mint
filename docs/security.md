# Security Model

The production deployment path runs the mint on GCP Confidential Space. The
goal is that mint secrets and app-level Cloud KMS decrypt capability are only
available to the expected, attested container image.

## Trust Boundaries

| Component                    | Trusted with mint secrets? | Notes                                                                                                                                                                        |
| ---------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operator                     | No by default              | Can deploy and administer infrastructure, but the verifier checks that the VM service account has no direct Secret Manager accessor role and no direct app-KMS decrypt role. |
| Confidential Space container | Yes                        | Runs the mint and receives access only after Google Cloud attestation succeeds.                                                                                              |
| GCP Secret Manager           | Yes                        | Stores the mint runtime secret and, in Confidential Space mode, Caddy ACME storage. Production uses CMEK for these secrets.                                                  |
| Cloud KMS                    | Yes                        | Encrypts newly written keyset private keys and the Secret Manager CMEK.                                                                                                      |
| Private Cloud SQL            | No                         | Stores mint state. It is private-IP only and CMEK encrypted in the managed GCP path.                                                                                         |

## How Key Access Is Protected

Terraform creates a Workload Identity Pool provider for Google Cloud
attestation. In Confidential Space mode, Secret Manager access and app-level
Cloud KMS encrypt/decrypt are granted to a principal scoped to:

- the expected container image digest;
- the expected runtime service account;
- `CONFIDENTIAL_SPACE` attestation;
- stable Confidential Space support attributes;
- production image debug status.

The runtime VM service account launches the Confidential Space VM but does not
directly receive the Secret Manager accessor role or app-level Cloud KMS
encrypt/decrypt role.

## Boot Flow

```text
Confidential Space VM starts
    |
    v
Container launcher measures and starts the pinned image
    |
    v
Workload exchanges attestation token through Workload Identity Federation
    |
    v
Workload fetches Secret Manager payload and Cloud KMS access token
    |
    v
Workload restores Caddy ACME storage from an attestation-gated secret
    |
    v
Mint starts Caddy and Node.js inside the attested container
```

The secret payload is not written into Terraform state. For managed Postgres,
Terraform passes non-secret database metadata to the workload and the database
password remains in Secret Manager.

Caddy ACME account and certificate storage is persisted separately in a
CMEK-protected Secret Manager secret. The workload restores it before Caddy
starts and snapshots changed storage back to Secret Manager from inside the
attested container. CI can see only the secret resource name and IAM policy,
not the certificate private key material.

## Updating Without Revealing Keys

The release changes the allowed digest, not the plaintext keys.

1. GitHub Actions builds the Confidential Space container and records the image
   digest.
2. The workflow signs a GitHub Artifact Attestation for that digest.
3. Terraform updates the Workload Identity provider condition and Secret
   Manager / Cloud KMS IAM principal to the new digest.
4. The workflow restarts the Confidential Space VM so the launcher boots the
   new pinned image.
5. The verifier checks live GCP state and public mint health.
6. The workflow signs a deployment security attestation predicate for the same
   digest.

The verifier does not read the Secret Manager payload and does not call Cloud
KMS encrypt/decrypt. It validates the live resource configuration that decides
which workload can access those resources.

Deployment attestation artifacts are uploaded by the release workflow and
tracked in the private operations archive. The public repo should describe what
was checked and link to non-sensitive workflow runs; it should not publish
Secret Manager payloads, database URLs, admin bearer tokens, service account
keys, or raw audit log exports.

## What The Deployment Attestation Proves

The generated deployment predicate records evidence that:

- the running VM is a Confidential Space instance with Shielded VM enabled;
- instance metadata points at the expected pinned image digest;
- instance metadata does not contain database passwords, mint seeds, private
  keys, or full database URLs;
- the Workload Identity provider condition requires the expected image digest
  and Confidential Space claims;
- Secret Manager and app-level Cloud KMS IAM include the expected digest-bound
  principal;
- the VM service account lacks direct Secret Manager accessor and app-level
  Cloud KMS decrypt access;
- Secret Manager uses CMEK;
- Caddy ACME storage is persisted through a CMEK-protected Secret Manager
  secret whose access and version-add permissions are bound to the attested
  image digest;
- managed Cloud SQL is private-IP only and CMEK encrypted;
- audit log archive and alerting resources exist when required;
- the live mint endpoints are healthy.

## Audit Monitoring

Terraform can create a Cloud Logging sink, Cloud Storage archive bucket, and
Cloud Monitoring alert policy for sensitive admin activity. This makes later
IAM, Workload Identity, Cloud KMS, Secret Manager, VM, and Cloud SQL changes
observable.

The repository also includes a scheduled `GCP Confidential Space Audit Monitor`
workflow. It reruns the live deployment verifier and scans recent Cloud Audit
Logs for sensitive admin changes. The monitor allows the configured deploy
service account and fails on unexpected principals, which turns the release-time
attestation into an ongoing tamper-evidence check.

The Caddy ACME persistence loop writes new Secret Manager versions from inside
the attested workload. Cloud Audit Logs records those writes without a normal
principal email, so the monitor allows only anonymous-principal
`AddSecretVersion` events against the configured Caddy ACME secret. Other
Secret Manager mutations remain unexpected unless the actor is explicitly
allowlisted.

Terraform grants the monitor service account Cloud Logging read access when
`audit_monitor_reader_service_account_email` is configured. That permission is
limited to audit review and is separate from runtime secret/KMS access; the VM
service account still does not receive direct Secret Manager accessor or
app-level KMS decrypt permissions.

Data Access logs for Cloud KMS and Secret Manager provide stronger evidence of
later key and secret access, not only policy changes. The dev deployment keeps
these logs enabled through `audit_data_access_logs_enabled=true`; the release
verifier requires the matching project audit configs whenever that flag is set.

The audit archive bucket has retention configured. Retention locking should be
enabled only after the retention period is approved because Cloud Storage
retention locks are irreversible for that period.

## Residual Risks

- The audit monitor and Cloud Monitoring alert policy make later admin changes
  observable and fail CI on unexpected principals, but they still require human
  review of alerts and private evidence for incident response.
- The release workflow depends on GitHub repository and environment variables
  being configured correctly. The preflight job skips deployment if required
  configuration is missing.
- Cloud SQL still stores mint operational state. Confidential Space protects
  key access, but database integrity still depends on GCP IAM, private network
  controls, backups, and application-level validation.
