# OpenFGA authorization policy

This directory contains ZeroSheet's versioned relationship-authorization model,
its allow/deny test suite, and the idempotent provisioner used by the local IAM
laboratory.

## Files

- `model.fga` is the human-reviewed source of authorization policy.
- `model.tests.fga.yaml` proves organization, team, and workbook behavior in the
  OpenFGA CLI's embedded engine.
- `provision-authorization-model.mjs` creates one named store, writes a new
  immutable model only when policy changes, and generates `.env.openfga`.

## Trust boundary

OpenFGA stores relationships and returns decisions. It does not authenticate
users, read Keycloak sessions, query workbook ciphertext, or possess encryption
keys. The ZeroSheet API is the PEP that maps its authenticated product-user UUID
to an OpenFGA principal and enforces the result.

The local server uses a pre-shared bearer credential on a loopback-only HTTP
port. Production will use a non-public network endpoint and workload identity;
the OpenFGA playground remains disabled.

## Commands

```bash
pnpm infra:authorization:model:test
pnpm infra:authorization:up
pnpm infra:authorization:provision
pnpm infra:authorization:verify
```

The final verifier expects `pnpm dev` to be running.
