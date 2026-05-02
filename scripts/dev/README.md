# Dev Scripts

This directory contains manual diagnostics and one-off local helpers. They are
not part of the supported deploy path, CI contract, or release evidence.

Supported repo commands live in `package.json`. The production release path uses:

- `npm run build`
- `npm run lint`
- `npm run migrate`
- `npm run gcp:confidential-space:build`
- `npm run gcp:confidential-space:attest`

Before running anything here, inspect the script and target environment. Some
helpers call live endpoints, inspect deposits, or mutate a local database.

