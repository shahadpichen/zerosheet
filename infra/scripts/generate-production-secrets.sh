#!/usr/bin/env bash

# Generate the internal credentials required by the single-node release stack.
#
# The destination must be an explicit absolute directory. Existing files are
# never overwritten, because silently replacing a PostgreSQL/Keycloak/OpenFGA
# credential would lock running services out of durable state. Generated values
# are URL-safe where they become part of the OpenFGA PostgreSQL URI. Google
# client secrets cannot be generated locally; unmistakable disabled sentinels
# are created so the stack can start with both integrations disabled.
set -euo pipefail

if [[ $# -ne 1 || "$1" != /* || "$1" == "/" ]]; then
  echo "Usage: $0 /absolute/path/to/zerosheet/secrets" >&2
  exit 1
fi

secret_directory="$1"
secret_names=(
  postgres_admin_password
  zerosheet_db_password
  zerosheet_audit_db_password
  keycloak_db_password
  openfga_db_password
  openfga_datastore_uri
  keycloak_admin_password
  keycloak_bff_client_secret
  openfga_preshared_key
  google_oidc_client_secret
  google_storage_client_secret
  google_storage_token_key
)

install -d -m 0700 "$secret_directory"
for secret_name in "${secret_names[@]}"; do
  if [[ -e "$secret_directory/$secret_name" ]]; then
    echo "Refusing to overwrite $secret_directory/$secret_name" >&2
    exit 1
  fi
done

umask 077

# Base64url avoids URI delimiter characters and shell whitespace while
# retaining cryptographically secure bytes from OpenSSL's operating-system RNG.
random_base64url() {
  local byte_count="$1"
  openssl rand -base64 "$byte_count" | tr '+/' '-_' | tr -d '=\n'
}

write_secret() {
  local name="$1"
  local value="$2"

  # Compose implements file-backed secrets as read-only bind mounts and cannot
  # remap their root ownership to each container's different non-root UID. The
  # file therefore needs read bits for the service process. This does not make
  # it readable to other VPS users: the root-owned 0700 parent directory blocks
  # path traversal, while Compose mounts only explicitly granted files into a
  # container. The file is immutable to every service because no write bit is
  # set and the container-side mount is read-only.
  # Create privately while writing, then remove every write bit only after the
  # complete value is on disk. Creating the empty file as 0444 first would also
  # prevent this non-root development invocation from populating it.
  install -m 0600 /dev/null "$secret_directory/$name"
  printf '%s\n' "$value" >"$secret_directory/$name"
  chmod 0444 "$secret_directory/$name"
}

postgres_admin_password="$(random_base64url 48)"
zerosheet_db_password="$(random_base64url 48)"
zerosheet_audit_db_password="$(random_base64url 48)"
keycloak_db_password="$(random_base64url 48)"
openfga_db_password="$(random_base64url 48)"

write_secret postgres_admin_password "$postgres_admin_password"
write_secret zerosheet_db_password "$zerosheet_db_password"
write_secret zerosheet_audit_db_password "$zerosheet_audit_db_password"
write_secret keycloak_db_password "$keycloak_db_password"
write_secret openfga_db_password "$openfga_db_password"
write_secret openfga_datastore_uri \
  "postgres://openfga_app:${openfga_db_password}@postgres:5432/openfga?sslmode=disable"
write_secret keycloak_admin_password "$(random_base64url 48)"
write_secret keycloak_bff_client_secret "$(random_base64url 48)"
write_secret openfga_preshared_key "$(random_base64url 48)"
write_secret google_storage_token_key "$(random_base64url 32)"
write_secret google_oidc_client_secret \
  "disabled-replace-from-google-cloud-console"
write_secret google_storage_client_secret \
  "disabled-replace-from-google-cloud-console"

# Clear named shell variables that held database credentials. This cannot erase
# shell allocator copies, but it avoids keeping them reachable for later script
# logic and no value is written to stdout.
postgres_admin_password=""
zerosheet_db_password=""
zerosheet_audit_db_password=""
keycloak_db_password=""
openfga_db_password=""

echo "Created ${#secret_names[@]} secret files in $secret_directory."
echo "Replace both Google sentinel files only after creating separate OAuth clients."
