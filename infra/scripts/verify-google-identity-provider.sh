#!/usr/bin/env bash

# Verify the repeatable Google-to-Keycloak federation configuration.
#
# The provisioning command runs first because existing development realms do
# not re-import realm JSON. The read-only verifier then checks the values that
# Keycloak actually persisted, rather than assuming a successful HTTP status
# means every trust decision is correct.

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
environment_file="${repository_root}/.env"

if [[ ! -f "${environment_file}" ]]; then
  echo "Missing ${environment_file}. Copy .env.example to .env first." >&2
  exit 1
fi

"${repository_root}/infra/scripts/configure-google-identity-provider.sh"

node \
  --env-file="${environment_file}" \
  "${repository_root}/infra/keycloak/verify-google-identity-provider.mjs"
