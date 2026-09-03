#!/usr/bin/env bash

# Restore encrypted dumps into a disposable, networkless PostgreSQL container.
#
# This is intentionally not a production restore command. A random container
# with no port/network and no mounted application volume receives three fresh
# databases. The drill checks archive integrity and the product schema marker,
# then removes only that random container and mktemp directory. Live ZeroSheet
# containers, volumes, and databases are never targeted.
set -euo pipefail

if [[ $# -ne 2 || "$1" != /* || "$2" != /* ]]; then
  echo "Usage: $0 /absolute/backup-directory /absolute/age-identity-file" >&2
  exit 1
fi

backup_directory="$1"
age_identity_file="$2"
if [[ ! -r "$backup_directory/SHA256SUMS" ]]; then
  echo "Missing encrypted-backup checksum manifest." >&2
  exit 1
fi
for logical_name in product identity authorization; do
  if [[ ! -r "$backup_directory/$logical_name.dump.age" ]]; then
    echo "Missing encrypted $logical_name dump." >&2
    exit 1
  fi
done
if [[ ! -r "$age_identity_file" ]] || ! command -v age >/dev/null 2>&1; then
  echo "A readable age identity and the age command are required." >&2
  exit 1
fi

# Check transport/storage integrity before decrypting. `age` would also reject
# modified ciphertext cryptographically, but the manifest identifies a damaged
# or incomplete backup early and works with either GNU or macOS checksum tools.
(
  cd "$backup_directory"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum --check SHA256SUMS
  elif command -v shasum >/dev/null 2>&1; then
    shasum --algorithm 256 --check SHA256SUMS
  else
    echo "Install sha256sum or shasum to verify backup integrity." >&2
    exit 1
  fi
)

temporary_directory="$(mktemp -d)"
container_name="zerosheet-restore-drill-$(openssl rand -hex 8)"
cleanup() {
  docker rm --force "$container_name" >/dev/null 2>&1 || true
  rm -rf -- "$temporary_directory"
}
trap cleanup EXIT INT TERM

for logical_name in product identity authorization; do
  age --decrypt \
    --identity "$age_identity_file" \
    --output "$temporary_directory/$logical_name.dump" \
    "$backup_directory/$logical_name.dump.age"
done

# Trust authentication is safe only because this disposable container has no
# network device, published port, host data mount, or reused password.
docker run --detach \
  --name "$container_name" \
  --network none \
  --env POSTGRES_HOST_AUTH_METHOD=trust \
  postgres:17-alpine >/dev/null

for _attempt in {1..30}; do
  if docker exec "$container_name" pg_isready --username postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$container_name" pg_isready --username postgres >/dev/null

for logical_name in product identity authorization; do
  database_name="${logical_name}_restore_drill"
  docker exec "$container_name" createdb --username postgres "$database_name"
  docker cp "$temporary_directory/$logical_name.dump" "$container_name:/tmp/$logical_name.dump" >/dev/null
  docker exec "$container_name" pg_restore \
    --exit-on-error \
    --no-owner \
    --no-privileges \
    --username postgres \
    --dbname "$database_name" \
    "/tmp/$logical_name.dump"
done

schema_version="$(docker exec "$container_name" psql --tuples-only --no-align --username postgres --dbname product_restore_drill --command "SELECT version FROM schema_migrations WHERE version = '007_security_drift_auditor'")"
if [[ "$schema_version" != "007_security_drift_auditor" ]]; then
  echo "The restored product database is missing the expected schema marker." >&2
  exit 1
fi

echo "Isolated restore drill passed for product, identity, and authorization databases."
