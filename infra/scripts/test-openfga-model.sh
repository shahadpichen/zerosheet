#!/usr/bin/env bash

# Run model tests in the OpenFGA CLI's embedded engine.
#
# No persistent server is needed for this command. That makes authorization
# policy tests fast enough for every pre-push quality gate and ensures malformed
# or over-broad model changes fail before deployment.

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

docker run --rm \
  --volume "${repository_root}/infra/openfga:/model:ro" \
  openfga/cli:v0.7.20 \
  model test \
  --tests /model/model.tests.fga.yaml
