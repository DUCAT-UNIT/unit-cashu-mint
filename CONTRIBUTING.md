# Contributing

## Local dev loop

```bash
git clone <repo> && cd mint-server
npm install
cp .env.example .env       # edit values for your local LN backend
docker-compose up -d        # postgres, regtest bitcoin, etc.
npm run dev                 # mint on :3338
npm test                    # unit
npm run test:integration    # integration
```

## Layout

```
src/         mint application (TypeScript)
enclave/     enclave-side image build (Dockerfile, nginx, entrypoint)
parent/      parent EC2 scripts, systemd units, KMS policy, vsock proxies
terraform/   AWS infra (VPC, EC2, IAM, KMS bootstrap)
scripts/     dev/ops one-offs
docs/        architecture + security + deployment docs
examples/    sample configs (nginx, env, tfvars)
tests/       unit + integration
```

## Where to read first

If you're reviewing this for security/architecture rather than running it:

1. [`docs/architecture.md`](./docs/architecture.md) — components and request flow
2. [`docs/security.md`](./docs/security.md) — trust model, KMS+PCR0 sealing, gaps
3. [`parent/kms-policy.json`](./parent/kms-policy.json) — the actual lock
4. [`enclave/nginx.conf`](./enclave/nginx.conf) — TLS terminates here

## Conventions

- TypeScript, ESM, Node 20
- Vitest for tests
- Prettier + ESLint configured; CI runs both
- Keep `parent/`, `enclave/`, and `terraform/` changes in their own commits
  when possible — they each touch different deploy machinery

## Deploy

`main` triggers the enclave deploy via GitHub Actions OIDC. Path-filtered to
`src/**`, `enclave/**`, `package*.json`. Doc-only changes don't redeploy.

A new enclave build produces a new PCR0; the KMS policy must be updated to
include it before the new enclave can unseal secrets. See
[`docs/security.md`](./docs/security.md#updating-the-enclave-without-exposing-the-key).
