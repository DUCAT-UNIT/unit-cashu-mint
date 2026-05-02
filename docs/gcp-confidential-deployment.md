# GCP Confidential VM Deployment

This deploys the mint on a Google Cloud Confidential VM. It is the closest
GCP equivalent to the current AWS Nitro deployment for a single VM, but the
security model is different:

- AWS Nitro Enclaves isolate the mint from the parent EC2 instance.
- GCP Confidential VM encrypts the whole VM memory from the cloud operator and
  host, but the guest OS remains inside the trust boundary.
- This deployment has a startup attestation gate: it refuses to fetch Secret
  Manager payloads unless Compute Engine reports Confidential VM and Shielded VM
  controls enabled for the instance.
- True Nitro-style KMS release on GCP requires Confidential Space, a container
  image digest, and Workload Identity Federation IAM bindings. That is the
  closer match for attestation-gated secret release because KMS access is granted
  to attested workload claims instead of the VM service account.

## What Terraform Creates

- VPC, subnet, firewall, and static IP
- Confidential VM with Shielded VM enabled
- Runtime service account
- Cloud KMS key for encrypted boot disk and application keyset encryption
- Cloud KMS key for Secret Manager CMEK
- IAM wiring for the Secret Manager secret and KMS keys
- Startup automation that installs Postgres, Node.js 22, Caddy, the mint app,
  migrations, and a systemd service

## Bootstrap

```bash
cd terraform/gcp
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars`, then create the secret payload before first boot.
Use a CMEK-protected secret in production:

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

On GCP, startup appends the runtime encryption settings below after reading the
secret, so Cloud KMS is authoritative even if the secret still contains
`KEY_ENCRYPTION_MODE=local` for local development:

```dotenv
KEY_ENCRYPTION_MODE=gcp-kms
KMS_KEY_NAME=projects/.../locations/.../keyRings/.../cryptoKeys/...
```

`ENCRYPTION_KEY` should remain available during migration because the app can
still read legacy local AES-CBC keyset rows, but newly written keyset private
keys are encrypted with Cloud KMS when `KEY_ENCRYPTION_MODE=gcp-kms`.

Then apply:

```bash
terraform init
terraform plan
terraform apply
```

Point the DNS A record for `domain_name` to the `public_ip` output before
Caddy requests the certificate.

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
- The startup attestation gate blocks accidental non-Confidential-VM boots
  before secrets are fetched, but root inside the guest remains trusted.
- For production-grade Nitro-style KMS attestation gating on GCP, move the
  signing workload into Confidential Space and grant KMS decrypt to the
  attested workload identity, usually bound to the container image digest.
