#!/usr/bin/env bash

# Create or update Keycloak's Google identity provider without exposing secrets.
#
# Realm startup import is intentionally skipped after a realm already exists,
# because overwriting a live realm would destroy administrator and user changes.
# This wrapper therefore loads the ignored local `.env` file and invokes the
# idempotent Keycloak Admin REST client. Running it again updates the existing
# provider instead of creating duplicates.

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
environment_file="${repository_root}/.env"

if [[ ! -f "${environment_file}" ]]; then
  echo "Missing ${environment_file}. Copy .env.example to .env first." >&2
  exit 1
fi

# Node 24 reads the environment file itself. This is safer than shell-sourcing
# values that may contain characters with special meaning to Bash. It also keeps
# passwords and client secrets out of process command-line arguments.
node \
  --env-file="${environment_file}" \
  "${repository_root}/infra/keycloak/configure-google-identity-provider.mjs"
