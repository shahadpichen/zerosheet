#!/usr/bin/env bash

# Create encrypted logical backups of the three service-isolated databases.
#
# pg_dump runs inside the private PostgreSQL container and reads the mounted
# administrator file there. Plaintext custom-format dumps live only in a
# mktemp directory, are encrypted with the operator's age recipient, and are
# removed on every exit path. The script never reads or logs a database secret.
set -euo pipefail

if [[ $# -ne 3 || "$1" != /* || "$2" != /* ]]; then
  echo "Usage: $0 /absolute/environment-file /absolute/output-directory AGE_RECIPIENT" >&2
  exit 1
fi

environment_file="$1"
output_directory="$2"
age_recipient="$3"
repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
compose_file="$repository_root/infra/production/compose.yaml"

if [[ ! -r "$environment_file" ]]; then
  echo "The production environment file is not readable." >&2
  exit 1
fi
if ! command -v age >/dev/null 2>&1; then
  echo "Install age before creating encrypted backups." >&2
  exit 1
fi

install -d -m 0700 "$output_directory"
temporary_directory="$(mktemp -d)"
cleanup() {
  rm -rf -- "$temporary_directory"
}
trap cleanup EXIT INT TERM

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_directory="$output_directory/$timestamp"
if [[ -e "$backup_directory" ]]; then
  echo "A backup with this UTC timestamp already exists." >&2
  exit 1
fi
install -d -m 0700 "$backup_directory"

dump_database() {
  local logical_name="$1"
  local container_database_variable="$2"
  local plaintext="$temporary_directory/$logical_name.dump"
  local encrypted="$backup_directory/$logical_name.dump.age"

  docker compose \
    --env-file "$environment_file" \
    --file "$compose_file" \
    exec --no-TTY postgres \
    sh -c 'PGPASSWORD="$(cat /run/secrets/postgres_admin_password)" exec pg_dump --format=custom --no-owner --no-privileges --username "$POSTGRES_USER" --dbname "$(printenv "$1")"' \
    sh "$container_database_variable" >"$plaintext"

  if [[ ! -s "$plaintext" ]]; then
    echo "The $logical_name database dump was empty." >&2
    exit 1
  fi
  age --recipient "$age_recipient" --output "$encrypted" "$plaintext"
  chmod 0600 "$encrypted"
}

dump_database product ZEROSHEET_DB_NAME
dump_database identity KEYCLOAK_DB_NAME
dump_database authorization OPENFGA_DB_NAME

(
  cd "$backup_directory"
  sha256sum ./*.dump.age >SHA256SUMS
  chmod 0600 SHA256SUMS
)

echo "Encrypted database backup created at $backup_directory"
echo "Move it off-site and run the isolated restore drill before counting it as recoverable."
