#!/usr/bin/env bash

# This verifier is the executable Milestone 13 acceptance checklist. It keeps
# the important cross-package commands together so future changes do not prove
# only one layer while accidentally breaking the identity, envelope, Google
# permission, or persistence layer beside it.
set -euo pipefail

# Resolve from this file instead of assuming the caller's current directory.
# That makes `pnpm infra:sharing:verify` and direct script execution equivalent.
SCRIPT_DIRECTORY="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT="$(cd -- "${SCRIPT_DIRECTORY}/../.." && pwd)"

cd "${REPOSITORY_ROOT}"

# Migration replay is intentional. Each SQL migration is idempotent, so this
# checks both a fresh schema transition and safe startup against an existing
# development database without deleting user data.
pnpm infra:db:migrate

# API unit tests cover authenticated routes, envelope validation, the sharing
# coordinator, fail-closed behavior, and staged/committed rotation semantics.
pnpm --filter @zerosheet/api test

# The Google adapter owns exact permission creation/deletion and stable sheet
# tab discovery. The crypto package owns HPKE and phrase-backup primitives. They
# are tested separately so a passing API fake cannot hide a provider/crypto bug.
pnpm --filter @zerosheet/google-storage test
pnpm --filter @zerosheet/crypto test

# The browser coordinator is the only place that can combine a recovery phrase,
# a raw workbook-key byte array, an HPKE seal, and Google permission changes.
# Its tests prove post-reload sharing works and rollback targets the exact newly
# created permission while the transient raw key is cleared.
pnpm --filter @zerosheet/web test

# Normal test runs skip external PostgreSQL access. This explicit flag enables
# the real migration-backed lifecycle test and its deterministic fixture cleanup.
ZEROSHEET_RUN_DB_INTEGRATION=true pnpm --filter @zerosheet/api exec vitest run \
  src/encryption/postgres-workbook-security-repository.integration.test.ts

# Both sides share runtime-validated contracts. Type-checking them together
# catches drift in route results and the browser's saga coordinator.
pnpm --filter @zerosheet/api typecheck
pnpm --filter @zerosheet/web typecheck

echo "Secure workbook sharing verification passed."
