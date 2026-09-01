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

# Fail with a clear message before executing SQL if Compose did not provide one
# of the required values. The ":?" syntax is POSIX shell parameter validation.
: "${ZEROSHEET_DB_NAME:?ZEROSHEET_DB_NAME is required}"
: "${ZEROSHEET_DB_USER:?ZEROSHEET_DB_USER is required}"
: "${ZEROSHEET_DB_PASSWORD:?ZEROSHEET_DB_PASSWORD is required}"
: "${KEYCLOAK_DB_NAME:?KEYCLOAK_DB_NAME is required}"
: "${KEYCLOAK_DB_USER:?KEYCLOAK_DB_USER is required}"
: "${KEYCLOAK_DB_PASSWORD:?KEYCLOAK_DB_PASSWORD is required}"
: "${OPENFGA_DB_NAME:?OPENFGA_DB_NAME is required}"
: "${OPENFGA_DB_USER:?OPENFGA_DB_USER is required}"
: "${OPENFGA_DB_PASSWORD:?OPENFGA_DB_PASSWORD is required}"

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
