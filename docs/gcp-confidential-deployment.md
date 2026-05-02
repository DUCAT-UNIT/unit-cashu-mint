# GCP Confidential Deployment

This module supports two GCP deployment modes:

- `deployment_mode = "confidential-vm"` keeps the current single VM startup
  script path. It uses a Confidential VM, encrypted boot disk, Secret Manager,
  app-level Cloud KMS encryption, and a startup gate that refuses to fetch
  secrets unless the instance reports Confidential VM and Shielded VM controls.
- `deployment_mode = "confidential-space"` is the production-grade path for
  Nitro-style attestation-gated release. The mint runs as a single Confidential
  Space container. Secret Manager access and Cloud KMS encrypt/decrypt are
  granted to a Workload Identity Federation principal bound to the attested
  container image digest, not to the VM service account.

## What Terraform Creates

- VPC, subnet, firewall, and static IP
- Required GCP project APIs, unless `manage_project_services = false`
- Confidential VM with Shielded VM enabled
- Runtime service account
- Cloud KMS key for encrypted boot disk and application keyset encryption
- Cloud KMS key for Secret Manager CMEK
- IAM wiring for the Secret Manager secret and KMS keys
- Optional Artifact Registry Docker repository for the workload image
- Optional private Cloud SQL for PostgreSQL instance for the Confidential Space
  path
- In `confidential-vm` mode: startup automation that installs Postgres, Node.js
  22, Caddy, the mint app, migrations, and a systemd service
- In `confidential-space` mode: a Workload Identity Pool/provider for Google
  Cloud Attestation, principalSet IAM bindings scoped to the expected image
  digest, and a Confidential Space VM that launches the attested container

## Bootstrap

```bash
cd terraform/gcp
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars`, then create the secret payload before first boot.
Use a CMEK-protected secret in production. In `confidential-space` mode this
secret is fetched with a federated token issued only after Confidential Space
attestation passes:

```bash
gcloud secrets create ducat-mint-env \
  --replication-policy=automatic \
  --kms-key-name="$(terraform output -raw secret_manager_cmek_key_name)"
gcloud secrets versions add ducat-mint-env --data-file=/path/to/mint.env
```

For an existing secret, update the CMEK configuration and add a new version
after Terraform creates `secret_manager_cmek_key_name`. Existing versions are
not re-encrypted by Secret Manager; only versions added after the CMEK update
use the new key.

The `mint.env` file must contain the sensitive and chain-specific values:

```dotenv
ENCLAVE_MODE=false
NETWORK=mainnet
ESPLORA_URL=https://mempool.space/api
ORD_URL=https://ord.example.com
MEMPOOL_URL=https://mempool.space/api
SUPPORTED_UNITS=unit,btc
SUPPORTED_RUNES=1527352:1
MINT_BTC_ADDRESS=bc1...
LIGHTNING_BACKEND=lnbits
LNBITS_URL=https://legend.lnbits.com
LNBITS_INVOICE_KEY=...
LNBITS_ADMIN_KEY=...
LIGHTNING_FEE_RESERVE=2
MINT_SEED=64_hex_chars
MINT_PUBKEY=...
MINT_INPUT_FEE_PPK=0
ENCRYPTION_KEY=64_hex_chars
JWT_SECRET=strong_secret
MINT_NAME=Ducat Mint
MINT_DESCRIPTION=Cashu ecash backed by UNIT and BTC
MINT_CONFIRMATIONS=1
MELT_CONFIRMATIONS=1
CORS_ORIGINS=https://cashu.me
```

For `confidential-space`, either include a complete `DATABASE_URL` in the
Secret Manager payload, or enable `managed_postgres_enabled` and include only
the database password in the payload:

```dotenv
DB_PASSWORD=the_same_value_as_terraform_db_password
```

When `managed_postgres_enabled = true`, Terraform passes only non-secret
`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, and `DB_SSLMODE` metadata to the
attested container. The password remains in Secret Manager and is fetched only
after the Confidential Space attestation token can be exchanged through the
Workload Identity Provider.

On GCP, startup appends the runtime encryption settings below after reading the
secret in `confidential-vm` mode, so Cloud KMS is authoritative even if the
secret still contains `KEY_ENCRYPTION_MODE=local` for local development:

```dotenv
KEY_ENCRYPTION_MODE=gcp-kms
KMS_KEY_NAME=projects/.../locations/.../keyRings/.../cryptoKeys/...
```

In `confidential-space` mode the attested container sets:

```dotenv
KEY_ENCRYPTION_MODE=gcp-confidential-space-kms
KMS_KEY_NAME=projects/.../locations/.../keyRings/.../cryptoKeys/...
GCP_WORKLOAD_IDENTITY_AUDIENCE=//iam.googleapis.com/projects/.../locations/global/workloadIdentityPools/.../providers/...
```

`ENCRYPTION_KEY` should remain available during migration because the app can
still read legacy local AES-CBC keyset rows, but newly written keyset private
keys are encrypted with Cloud KMS when `KEY_ENCRYPTION_MODE` uses either GCP
KMS mode.

Then apply:

```bash
terraform init
terraform plan
terraform apply
```

Point the DNS A record for `domain_name` to the `public_ip` output before
Caddy requests the certificate.

## Confidential Space Build

If Docker and gcloud are available locally, build and push the workload
container from the repository root:

```bash
IMAGE="us-central1-docker.pkg.dev/$PROJECT_ID/ducat-mint/mint-server:$(git rev-parse --short HEAD)"
docker build -f gcp-confidential-space/Dockerfile -t "$IMAGE" .
docker push "$IMAGE"
gcloud artifacts docker images describe "$IMAGE" \
  --format='value(image_summary.digest)'
```

On a machine without Docker or gcloud, use Cloud Build through Application
Default Credentials:

```bash
node scripts/gcp-confidential-space-build.mjs \
  --project "$PROJECT_ID" \
  --location us-central1 \
  --repository ducat-mint \
  --image mint-server
```

The helper creates the Artifact Registry repository and a Cloud Storage source
bucket when they do not exist, submits the Docker build to Cloud Build, and
prints the pinned image reference and digest.

Set these in `terraform.tfvars`:

```hcl
deployment_mode = "confidential-space"

confidential_space_image_reference = "us-central1-docker.pkg.dev/PROJECT_ID/ducat-mint/mint-server@sha256:..."
confidential_space_image_digest    = "sha256:..."
confidential_space_image_family    = "confidential-space"
```

The digest is part of the Workload Identity Provider attestation condition and
the KMS/Secret Manager IAM principalSet. A new container digest intentionally
requires a Terraform update before the new workload can decrypt.

## Release CI And Attestation

`.github/workflows/gcp-confidential-space-release.yml` is the release path for
digest updates. It:

1. runs static checks;
2. authenticates to GCP through GitHub OIDC;
3. builds the Confidential Space container in Cloud Build;
4. signs GitHub Artifact Attestations for the image digest;
5. runs Terraform with the new image reference and digest;
6. stop/starts the Confidential Space VM so the launcher boots the new digest;
7. verifies the live deployment and writes a signed custom deployment
   attestation predicate for the same image digest.

The deployment verifier is `scripts/gcp-confidential-space-attest.mjs`. It does
not read Secret Manager payloads and does not call Cloud KMS encrypt/decrypt.
It checks live GCP state instead:

- the VM is a running Confidential Space instance with Shielded VM enabled;
- instance metadata points at the expected pinned image digest and contains no
  DB password, `DATABASE_URL`, mint seed, or mint private key;
- the Workload Identity provider condition requires the expected image digest,
  runtime service account, `CONFIDENTIAL_SPACE`, stable support, and production
  debug status;
- app-level Cloud KMS and Secret Manager IAM include the expected digest-bound
  principalSet;
- the runtime VM service account has no direct app-KMS decrypt or Secret
  Manager accessor role;
- Secret Manager uses CMEK, Cloud SQL is private-IP only and CMEK encrypted,
  and the public mint endpoints are healthy.

The workflow needs these GitHub environment/repository variables:

```text
GCP_PROJECT_ID
GCP_WORKLOAD_IDENTITY_PROVIDER
GCP_DEPLOY_SERVICE_ACCOUNT
GCP_TF_STATE_BUCKET
GCP_MINT_DOMAIN_NAME
GCP_TLS_EMAIL
```

And this GitHub secret:

```text
GCP_MINT_DB_PASSWORD
```

Optional variables include `GCP_REGION`, `GCP_ZONE`,
`GCP_ARTIFACT_REGISTRY_LOCATION`, `GCP_ARTIFACT_REGISTRY_REPOSITORY`,
`GCP_ARTIFACT_REGISTRY_IMAGE`, `GCP_CLOUD_BUILD_SOURCE_BUCKET`,
`GCP_TF_STATE_PREFIX`, `GCP_AUDIT_ALERT_EMAIL`,
`GCP_AUDIT_LOG_ARCHIVE_BUCKET_NAME`, `GCP_AUDIT_LOG_RETENTION_DAYS`,
`GCP_AUDIT_LOG_ARCHIVE_RETENTION_LOCKED`, and
`GCP_AUDIT_DATA_ACCESS_LOGS_ENABLED`.

The CI deploy expects Terraform state in a GCS backend. For the already-running
dev deployment, migrate the local state into the configured state bucket before
turning on CI applies. Without that migration, CI has no knowledge of the
existing resources and must not be used to apply.

## Post-Deploy Audit Monitoring

Set `audit_monitoring_enabled = true` to make later privileged changes
observable. Terraform creates:

- a dedicated Cloud Storage archive bucket for sensitive Cloud Audit Logs;
- a Cloud Logging sink for IAM, Workload Identity, KMS, Secret Manager,
  Confidential Space VM, and Cloud SQL admin activity;
- a Cloud Monitoring log-match alert policy for sensitive admin mutations such
  as `SetIamPolicy`, Workload Identity provider updates, KMS/Secret Manager
  mutations, VM metadata/service-account changes, and service-account key
  creation;
- an optional email notification channel when `audit_alert_email` is set.

For stronger historical evidence, set `audit_data_access_logs_enabled = true`.
That enables Data Access audit logs for Cloud KMS and Secret Manager and routes
those logs into the same archive. This can increase log volume, but it lets
reviewers inspect later KMS and secret access, not only policy changes.

Set `audit_log_archive_retention_locked = true` only after testing. Locking the
Cloud Storage retention policy is irreversible for the configured retention
period.

The release verifier automatically requires these audit resources when
`TF_VAR_audit_monitoring_enabled=true`; the generated deployment attestation
then includes evidence that the archive sink and alert policy exist. When
`TF_VAR_audit_data_access_logs_enabled=true`, it also verifies that KMS and
Secret Manager Data Access audit logs are enabled.

For the fully managed database path, also set:

```hcl
managed_postgres_enabled = true
db_name                  = "mintdb"
db_user                  = "mintuser"
db_password              = "the_same_value_present_as_DB_PASSWORD_in_mint_env"
```

Cloud SQL is private-IP only and encrypted with the module KMS key. The VM
service account is not granted Secret Manager or app-level KMS decrypt access
in `confidential-space` mode; the federated principal bound to the attested
container digest is.

## Verify

```bash
curl https://cashu-mint.yourdomain.com/health
curl https://cashu-mint.yourdomain.com/v1/info
```

Expected compatibility signal in `/v1/info`:

```json
{
  "nuts": {
    "4": {
      "methods": [
        { "method": "unit", "unit": "unit" },
        { "method": "onchain", "unit": "sat" },
        { "method": "bolt11", "unit": "sat" }
      ]
    },
    "5": {
      "methods": [
        { "method": "unit", "unit": "unit" },
        { "method": "onchain", "unit": "sat" },
        { "method": "bolt11", "unit": "sat" }
      ]
    },
    "20": { "supported": true },
    "23": { "supported": true },
    "26": { "supported": true }
  }
}
```

## Operational Commands

```bash
gcloud compute ssh <instance_name> --zone <zone>
sudo journalctl -u ducat-mint -f
sudo journalctl -u caddy -f
sudo systemctl restart ducat-mint
```

## Security Notes

- Keep `mint.env` out of git. It contains the mint seed.
- Secret Manager CMEK protects new secret versions at rest with the Terraform
  `secret_manager_cmek_key_name` key.
- Keyset private keys stored in Postgres are encrypted by the app with
  `app_kms_key_name` when running on GCP.
- In `confidential-vm` mode, root inside the guest remains trusted.
- In `confidential-space` mode, KMS and Secret Manager are not granted to the VM
  service account. Access is granted to the federated Confidential Space
  principal with these attestation conditions: expected container digest,
  expected runtime service account, `CONFIDENTIAL_SPACE`, stable image support,
  and production debug status.
