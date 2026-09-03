#!/usr/bin/env bash

# Keycloak does not use Docker's generic `_FILE` convention for ordinary
# database/bootstrap variables. This narrow wrapper reads only the explicitly
# allowlisted files, rejects ambiguous or multiline values, exports them to the
# Keycloak process, and never prints secret contents.
set -euo pipefail

load_secret() {
  local target_name="$1"
  local file_name="${target_name}_FILE"
  local direct_value="${!target_name:-}"
  local file_path="${!file_name:-}"

  if [[ -n "$direct_value" && -n "$file_path" ]]; then
    printf '%s\n' "$target_name and $file_name cannot both be set" >&2
    exit 1
  fi
  if [[ -z "$direct_value" ]]; then
    if [[ "$file_path" != /* || ! -r "$file_path" ]]; then
      printf '%s\n' "$file_name must be an absolute readable path" >&2
      exit 1
    fi
    direct_value="$(<"$file_path")"
  fi
  if [[ -z "$direct_value" || "$direct_value" == *$'\n'* || "$direct_value" == *$'\r'* ]]; then
    printf '%s\n' "$target_name must contain one non-empty secret value" >&2
    exit 1
  fi

  printf -v "$target_name" '%s' "$direct_value"
  export "$target_name"
}

load_secret KC_DB_PASSWORD
load_secret KC_BOOTSTRAP_ADMIN_PASSWORD
load_secret KEYCLOAK_BFF_CLIENT_SECRET
load_secret GOOGLE_OIDC_CLIENT_SECRET

exec /opt/keycloak/bin/kc.sh "$@"
