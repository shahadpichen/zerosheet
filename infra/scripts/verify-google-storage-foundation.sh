#!/usr/bin/env bash

# Verify the parts of delegated Google storage that do not require a real
# Google account or OAuth consent. Interactive provider consent stays a manual
# developer step, while this script proves the adapter, OAuth service, HTTP
# boundary, token encryption, and persisted database shape on every machine.

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
compose_file="${repository_root}/infra/compose.yaml"
environment_file="${repository_root}/.env"

cd "${repository_root}"

# Focused tests are intentionally repeated here even though the root suite also
# runs them. This command is the shortest learning-lab proof for Milestone 11.
pnpm --filter @zerosheet/google-storage test
pnpm --filter @zerosheet/api test

if [[ ! -f "${environment_file}" ]]; then
  echo "Missing ${environment_file}. Copy .env.example to .env first." >&2
  exit 1
fi

# Migrations are idempotent. Applying them here proves the exact schema checked
# below exists before a developer enables real Google credentials in the API.
pnpm infra:db:migrate

# Query only schema metadata and row counts. Refresh-token envelopes are never
# selected or printed by verification tooling, even in the local lab.
schema_summary="$({
  docker compose \
    --env-file "${environment_file}" \
    --file "${compose_file}" \
    exec --no-TTY postgres \
    sh -c 'PGPASSWORD="$ZEROSHEET_DB_PASSWORD" exec psql --tuples-only --no-align --set=ON_ERROR_STOP=1 --username "$ZEROSHEET_DB_USER" --dbname "$ZEROSHEET_DB_NAME"' <<'SQL'
SELECT concat(
  (SELECT count(*) FROM schema_migrations WHERE version = '005_google_storage_oauth'),
  '|',
  (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'google_storage_oauth_transactions'),
  '|',
  (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'google_storage_connections'),
  '|',
  (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'google_storage_connections' AND column_name = 'refresh_token')
);
SQL
} | tr -d '[:space:]')"

if [[ "${schema_summary}" != "1|1|1|0" ]]; then
  echo "Google storage schema verification failed." >&2
  exit 1
fi

echo "Google storage foundation verified without printing OAuth credentials."
