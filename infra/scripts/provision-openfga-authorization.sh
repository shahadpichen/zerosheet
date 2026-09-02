#!/usr/bin/env bash

# Validate, transform, and provision ZeroSheet's OpenFGA model.
#
# The official CLI is a one-shot tool, not another long-running VPS service. It
# converts the human-readable DSL into the JSON syntax accepted by OpenFGA. The
# Node provisioner then creates or updates the persistent model idempotently.

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
environment_file="${repository_root}/.env"

if [[ ! -f "${environment_file}" ]]; then
  echo "Missing ${environment_file}. Copy .env.example to .env first." >&2
  exit 1
fi

docker run --rm \
  --volume "${repository_root}/infra/openfga:/model:ro" \
  openfga/cli:v0.7.20 \
  model transform \
  --file /model/model.fga \
  --output-format json |
  node \
    --env-file="${environment_file}" \
    "${repository_root}/infra/openfga/provision-authorization-model.mjs"
