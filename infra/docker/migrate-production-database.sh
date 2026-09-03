#!/bin/sh

# This one-shot job applies the ordered ZeroSheet migrations over the private
# Docker network. It reads the application database password from a mounted
# file, keeps it out of Compose metadata and command arguments, and relies on
# each migration's transaction/idempotency guards for safe restart.
set -eu

secret_file="${ZEROSHEET_DB_PASSWORD_FILE:-}"
case "$secret_file" in
  /*) ;;
  *) echo "ZEROSHEET_DB_PASSWORD_FILE must be an absolute path" >&2; exit 1 ;;
esac
if [ ! -r "$secret_file" ]; then
  echo "ZEROSHEET_DB_PASSWORD_FILE must be readable" >&2
  exit 1
fi

PGPASSWORD="$(cat "$secret_file")"
case "$PGPASSWORD" in
  ""|*"
"*) echo "The database password file must contain one value" >&2; exit 1 ;;
esac
export PGPASSWORD

for migration in /migrations/*.sql; do
  echo "Applying $(basename "$migration")"
  psql \
    --host "${ZEROSHEET_DB_HOST:?ZEROSHEET_DB_HOST is required}" \
    --port "${ZEROSHEET_DB_PORT:-5432}" \
    --username "${ZEROSHEET_DB_USER:?ZEROSHEET_DB_USER is required}" \
    --dbname "${ZEROSHEET_DB_NAME:?ZEROSHEET_DB_NAME is required}" \
    --set "audit_role=${ZEROSHEET_AUDIT_DB_USER:-zerosheet_auditor}" \
    --set ON_ERROR_STOP=1 \
    --file "$migration"
done
