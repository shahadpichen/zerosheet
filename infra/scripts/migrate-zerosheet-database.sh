#!/usr/bin/env bash

# Apply ZeroSheet-owned PostgreSQL migrations in lexical order.
#
# The script executes psql inside the existing PostgreSQL container. It does not
# expose the administrator credential and authenticates as zerosheet_app, which
# proves every application table can be created with the same least-privilege
# role the API uses at runtime.

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
compose_file="${repository_root}/infra/compose.yaml"
environment_file="${repository_root}/.env"
migration_directory="${repository_root}/infra/postgres/migrations"

if [[ ! -f "${environment_file}" ]]; then
  echo "Missing ${environment_file}. Copy .env.example to .env first." >&2
  exit 1
fi

# nullglob prevents an unmatched *.sql pattern from being passed to psql as a
# literal filename. The explicit empty check gives a useful deployment failure.
shopt -s nullglob
migrations=("${migration_directory}"/*.sql)

if [[ ${#migrations[@]} -eq 0 ]]; then
  echo "No ZeroSheet database migrations were found." >&2
  exit 1
fi

for migration in "${migrations[@]}"; do
  echo "Applying $(basename "${migration}")..."

  # The postgres container already receives these variables from Compose. The
  # inner shell expands them inside the container, so secrets never appear as
  # literal arguments in this version-controlled script.
  docker compose \
    --env-file "${environment_file}" \
    --file "${compose_file}" \
    exec --no-TTY postgres \
    sh -c 'PGPASSWORD="$ZEROSHEET_DB_PASSWORD" exec psql --set=ON_ERROR_STOP=1 --username "$ZEROSHEET_DB_USER" --dbname "$ZEROSHEET_DB_NAME"' \
    < "${migration}"
done

echo "ZeroSheet database migrations are current."
