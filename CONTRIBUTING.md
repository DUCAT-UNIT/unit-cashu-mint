# Contributing

## Local Dev Loop

```bash
git clone <repo> && cd mint-server
npm install
cp .env.example .env
docker-compose up -d
npm run dev
npm test
npm run test:integration
```

## Layout

```text
src/                     mint application (TypeScript)
gcp-confidential-space/  Confidential Space container entrypoint and Caddy config
terraform/gcp/           GCP infrastructure
scripts/                 dev, build, deploy, and attestation helpers
docs/                    architecture, security, and deployment docs
tests/                   unit, integration, and compatibility coverage
```

## Where To Read First

If you are reviewing this for security or architecture:

1. [`docs/security.md`](./docs/security.md) - trust model, update flow, audit
   monitoring, and known gaps
2. [`docs/gcp-confidential-deployment.md`](./docs/gcp-confidential-deployment.md)
   - deployment and release workflow
3. [`terraform/gcp/main.tf`](./terraform/gcp/main.tf) - the actual GCP resource
   and IAM wiring
4. [`scripts/gcp-confidential-space-attest.mjs`](./scripts/gcp-confidential-space-attest.mjs)
   - the live deployment verifier

## Conventions

- TypeScript, ESM, Node 22
- Vitest for tests
- `npm test` runs the self-contained unit suite once; `npm run test:watch`
  starts Vitest watch mode; `npm run test:integration` runs database-backed
  integration coverage and starts the compose Postgres service when Docker is
  available.
- Prettier and ESLint configured; CI runs lint, build, unit tests, and
  integration tests
- Keep Terraform, release workflow, and application changes separated when the
  separation makes review easier

## Deploy

`main` triggers the GCP Confidential Space release workflow for application,
container, Terraform, package, and release workflow changes.

The workflow builds a new container image, pins the digest in Terraform,
applies the GCP update, restarts the Confidential Space VM, verifies the live
deployment, and signs a deployment security attestation. See
[`docs/security.md`](./docs/security.md#updating-without-revealing-keys).
