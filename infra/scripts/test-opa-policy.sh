#!/usr/bin/env bash

# Run contextual-policy tests inside the exact OPA version used by Compose.
#
# `--fail-on-empty` is important: a renamed or accidentally unmounted test file
# must fail the quality gate instead of reporting a misleading green result.
# No server, database, credentials, or network-exposed port is required.

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

docker run --rm \
  --volume "${repository_root}/infra/opa:/policy:ro" \
  openpolicyagent/opa:1.20.1 \
  test --fail-on-empty /policy
