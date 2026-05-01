# GCP Confidential VM Deployment

This deploys the mint on a Google Cloud Confidential VM. It is the closest
GCP equivalent to the current AWS Nitro deployment for a single VM, but the
security model is different:

- AWS Nitro Enclaves isolate the mint from the parent EC2 instance.
- GCP Confidential VM encrypts the whole VM memory from the cloud operator and
  host, but the guest OS remains inside the trust boundary.
- For stricter per-workload attestation on GCP, use Confidential Space as the
  next step. That is the closer match for attestation-gated secret release.

## What Terraform Creates

- VPC, subnet, firewall, and static IP
- Confidential VM with Shielded VM enabled
- Runtime service account
- Cloud KMS key for encrypted boot disk and future secret flows
- IAM wiring for an existing Secret Manager secret with mint environment variables
- Startup automation that installs Postgres, Node.js 22, Caddy, the mint app,
  migrations, and a systemd service

## Bootstrap

```bash
cd terraform/gcp
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars`, then create the secret payload before first boot:

```bash
gcloud secrets create ducat-mint-env --replication-policy=automatic
gcloud secrets versions add ducat-mint-env --data-file=/path/to/mint.env
```

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
ENCRYPTION_KEY=64_hex_chars
JWT_SECRET=strong_secret
MINT_NAME=Ducat Mint
MINT_DESCRIPTION=Cashu ecash backed by UNIT and BTC
MINT_CONFIRMATIONS=1
MELT_CONFIRMATIONS=1
CORS_ORIGINS=https://cashu.me
```

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
- The Terraform service account can read the mint Secret Manager secret. This
  is operationally useful, but it is not equivalent to Nitro PCR-gated KMS.
- For a production launch that needs enclave-style public attestation on GCP,
  move the signing workload into Confidential Space and release secrets based
  on attestation claims.
