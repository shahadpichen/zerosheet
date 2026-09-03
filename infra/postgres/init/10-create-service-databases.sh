#!/usr/bin/env sh

# This script creates an independent database owner for each service.
#
# Why not let every service use the PostgreSQL administrator?
# A vulnerability in one service would then grant access to all authentication,
# authorization, and encrypted-metadata records. Separate owners ensure that a
# compromised OpenFGA process, for example, cannot read Keycloak's tables.
#
# The official PostgreSQL image executes this file only while initializing an
# empty volume. All later schema changes must use explicit migrations so that a
# container restart can never make an unreviewed database change.

set -eu

# Service names are ordinary configuration, but passwords can arrive either as
# direct variables in the local learning lab or mounted files in production.
# The loader rejects ambiguity, relative paths, empty values, and multiline
# documents. It exports each value only inside this short-lived initialization
# process because psql needs the plaintext briefly to create the login role.
load_required_secret() {
  secret_name="$1"
  secret_file_name="${secret_name}_FILE"
  direct_value="$(printenv "$secret_name" 2>/dev/null || true)"
  secret_file="$(printenv "$secret_file_name" 2>/dev/null || true)"

  if [ -n "$direct_value" ] && [ -n "$secret_file" ]; then
    echo "$secret_name and $secret_file_name cannot both be set" >&2
    exit 1
  fi

  if [ -z "$direct_value" ]; then
    case "$secret_file" in
      /*) ;;
      *)
        echo "$secret_file_name must be an absolute readable path" >&2
        exit 1
        ;;
    esac
    if [ ! -r "$secret_file" ]; then
      echo "$secret_file_name must be an absolute readable path" >&2
      exit 1
    fi
    direct_value="$(cat "$secret_file")"
  fi

  case "$direct_value" in
    ""|*"
"*)
      echo "$secret_name must contain one non-empty secret value" >&2
      exit 1
      ;;
  esac

  export "$secret_name=$direct_value"
}

# Fail with a clear message before executing SQL if Compose did not provide the
# ordinary database/role names. Password contents never appear in diagnostics.
: "${ZEROSHEET_DB_NAME:?ZEROSHEET_DB_NAME is required}"
: "${ZEROSHEET_DB_USER:?ZEROSHEET_DB_USER is required}"
: "${KEYCLOAK_DB_NAME:?KEYCLOAK_DB_NAME is required}"
: "${KEYCLOAK_DB_USER:?KEYCLOAK_DB_USER is required}"
: "${OPENFGA_DB_NAME:?OPENFGA_DB_NAME is required}"
: "${OPENFGA_DB_USER:?OPENFGA_DB_USER is required}"

load_required_secret ZEROSHEET_DB_PASSWORD
load_required_secret KEYCLOAK_DB_PASSWORD
load_required_secret OPENFGA_DB_PASSWORD

# A new production database may create a login for the aggregate-only sharing
# auditor. Local labs created before this milestone omit these optional values;
# they can still exercise the function through the application owner.
if [ -n "${ZEROSHEET_AUDIT_DB_USER:-}" ]; then
  load_required_secret ZEROSHEET_AUDIT_DB_PASSWORD
fi

create_service_database() {
  service_database="$1"
  service_role="$2"
  service_password="$3"

  # psql variables keep values separate from SQL syntax. PostgreSQL's format()
  # function then quotes identifiers (%I) and password literals (%L) safely.
  #
  # REVOKE CONNECT FROM PUBLIC matters because PostgreSQL grants database
  # connection rights to PUBLIC by default. Without the revoke, creating
  # separate roles would look isolated while still allowing cross-database
  # connections.
  psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=service_database="$service_database" --set=service_role="$service_role" --set=service_password="$service_password" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'service_role', :'service_password')
WHERE NOT EXISTS (
  SELECT 1
  FROM pg_roles
  WHERE rolname = :'service_role'
)
\gexec

SELECT format('CREATE DATABASE %I OWNER %I', :'service_database', :'service_role')
WHERE NOT EXISTS (
  SELECT 1
  FROM pg_database
  WHERE datname = :'service_database'
)
\gexec

SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'service_database')
\gexec

SELECT format(
  'GRANT CONNECT, TEMPORARY ON DATABASE %I TO %I',
  :'service_database',
  :'service_role'
)
\gexec
SQL
}

create_service_database "$ZEROSHEET_DB_NAME" "$ZEROSHEET_DB_USER" "$ZEROSHEET_DB_PASSWORD"

create_service_database "$KEYCLOAK_DB_NAME" "$KEYCLOAK_DB_USER" "$KEYCLOAK_DB_PASSWORD"

create_service_database "$OPENFGA_DB_NAME" "$OPENFGA_DB_USER" "$OPENFGA_DB_PASSWORD"

if [ -n "${ZEROSHEET_AUDIT_DB_USER:-}" ]; then
  # The login gets CONNECT but no table grants. Migration 007 grants USAGE on
  # `public` plus EXECUTE on one SECURITY DEFINER aggregate function, keeping
  # rows, identifiers, OAuth envelopes, and key backups outside this account.
  psql \
    --username "$POSTGRES_USER" \
    --dbname "$POSTGRES_DB" \
    --set=service_database="$ZEROSHEET_DB_NAME" \
    --set=service_role="$ZEROSHEET_AUDIT_DB_USER" \
    --set=service_password="$ZEROSHEET_AUDIT_DB_PASSWORD" <<'SQL'
SELECT format(
  'CREATE ROLE %I LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L',
  :'service_role',
  :'service_password'
)
WHERE NOT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = :'service_role'
)
\gexec

SELECT format(
  'GRANT CONNECT ON DATABASE %I TO %I',
  :'service_database',
  :'service_role'
)
\gexec
SQL
fi
