#!/bin/sh

# The official OpenFGA binary accepts secrets through environment variables but
# has no generic `_FILE` loader. This wrapper runs in a tiny Alpine layer, reads
# only the datastore URI and pre-shared key mounted for this service, and then
# replaces itself with the exact pinned OpenFGA binary.
set -eu

load_secret() {
  target_name="$1"
  file_name="${target_name}_FILE"
  direct_value="$(printenv "$target_name" 2>/dev/null || true)"
  file_path="$(printenv "$file_name" 2>/dev/null || true)"

  if [ -n "$direct_value" ] && [ -n "$file_path" ]; then
    echo "$target_name and $file_name cannot both be set" >&2
    exit 1
  fi
  if [ -z "$direct_value" ]; then
    case "$file_path" in
      /*) ;;
      *) echo "$file_name must be an absolute readable path" >&2; exit 1 ;;
    esac
    if [ ! -r "$file_path" ]; then
      echo "$file_name must be an absolute readable path" >&2
      exit 1
    fi
    direct_value="$(cat "$file_path")"
  fi
  case "$direct_value" in
    ""|*"
"*) echo "$target_name must contain one non-empty secret value" >&2; exit 1 ;;
  esac
  export "$target_name=$direct_value"
}

load_secret OPENFGA_DATASTORE_URI
if [ "${OPENFGA_AUTHN_METHOD:-none}" = "preshared" ]; then
  load_secret OPENFGA_AUTHN_PRESHARED_KEYS
fi

exec /openfga "$@"
