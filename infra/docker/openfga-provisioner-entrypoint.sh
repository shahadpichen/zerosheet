#!/bin/sh

# The production provisioner is deliberately one-shot. The official FGA CLI
# transforms the reviewed DSL, then the existing idempotent Node provisioner
# creates/reuses the store and immutable model and writes only non-secret IDs to
# the mounted output directory.
set -eu

secret_file="${OPENFGA_PRESHARED_KEY_FILE:-}"
case "$secret_file" in
  /*) ;;
  *) echo "OPENFGA_PRESHARED_KEY_FILE must be an absolute path" >&2; exit 1 ;;
esac
if [ ! -r "$secret_file" ]; then
  echo "OPENFGA_PRESHARED_KEY_FILE must be readable" >&2
  exit 1
fi

OPENFGA_PRESHARED_KEY="$(cat "$secret_file")"
case "$OPENFGA_PRESHARED_KEY" in
  ""|*"
"*) echo "The OpenFGA key file must contain one value" >&2; exit 1 ;;
esac
export OPENFGA_PRESHARED_KEY

/usr/local/bin/fga model transform \
  --file /tools/model.fga \
  --output-format json |
  node /tools/provision-authorization-model.mjs
