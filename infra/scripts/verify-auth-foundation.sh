#!/usr/bin/env bash

# This script proves the direct-Google IAM foundation's security properties.
# A green Docker status cannot prove database isolation or the hosted provider's
# issuer/JWKS boundary, so each invariant is checked explicitly.

set -Eeuo pipefail

# Resolve paths from this script instead of the caller's current directory. This
# makes "pnpm infra:auth:verify" behave the same from any shell location.
repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
compose_file="$repository_root/infra/compose.yaml"
environment_file="$repository_root/.env"

if [[ ! -f "$environment_file" ]]; then
  echo "Missing $environment_file." >&2
  echo "Copy .env.example to .env and choose local-only passwords." >&2
  exit 1
fi

# Export the documented values so checks and Compose use the same database
# accounts and confidential Google client configuration.
set -a
# shellcheck disable=SC1090 -- the path is calculated and intentionally local.
source "$environment_file"
set +a

compose_arguments=(
  --env-file "$environment_file"
  --file "$compose_file"
  --profile auth-lab
)

compose() {
  docker compose "${compose_arguments[@]}" "$@"
}

database_query() {
  local database_user="$1"
  local database_password="$2"
  local database_name="$3"
  local sql="$4"

  # TCP is intentional. The official image may trust local Unix-socket
  # connections during initialization; TCP forces PostgreSQL password and
  # database CONNECT checks to participate in the test.
  compose exec --no-TTY --env "PGPASSWORD=$database_password" postgres psql --host 127.0.0.1 --username "$database_user" --dbname "$database_name" --tuples-only --no-align --command "$sql"
}

assert_database_owner_can_connect() {
  local database_user="$1"
  local database_password="$2"
  local database_name="$3"
  local actual_user

  actual_user="$(database_query "$database_user" "$database_password" "$database_name" "SELECT current_user;")"

  if [[ "$actual_user" != "$database_user" ]]; then
    echo "Expected $database_user while connecting to $database_name; received $actual_user." >&2
    exit 1
  fi

  echo "PASS: $database_user can connect to its own $database_name database."
}

assert_cross_database_connection_is_denied() {
  local database_user="$1"
  local database_password="$2"
  local forbidden_database="$3"

  # A successful command here would mean the role boundary is cosmetic. The
  # command's error output is hidden because denial is the expected result.
  if database_query "$database_user" "$database_password" "$forbidden_database" "SELECT current_user;" >/dev/null 2>&1; then
    echo "Isolation failure: $database_user connected to $forbidden_database." >&2
    exit 1
  fi

  echo "PASS: $database_user is denied access to $forbidden_database."
}

echo "Verifying PostgreSQL ownership and cross-database isolation..."

assert_database_owner_can_connect "$ZEROSHEET_DB_USER" "$ZEROSHEET_DB_PASSWORD" "$ZEROSHEET_DB_NAME"

assert_database_owner_can_connect "$OPENFGA_DB_USER" "$OPENFGA_DB_PASSWORD" "$OPENFGA_DB_NAME"

assert_cross_database_connection_is_denied "$ZEROSHEET_DB_USER" "$ZEROSHEET_DB_PASSWORD" "$OPENFGA_DB_NAME"

assert_cross_database_connection_is_denied "$OPENFGA_DB_USER" "$OPENFGA_DB_PASSWORD" "$ZEROSHEET_DB_NAME"

if [[ "$GOOGLE_OIDC_CLIENT_ID" == replace-with-* ]] ||
  [[ "$GOOGLE_OIDC_CLIENT_SECRET" == replace-with-* ]]; then
  echo "Google sign-in still contains placeholder OAuth credentials." >&2
  exit 1
fi

echo "Verifying Google's fixed OIDC authority and signing-key metadata..."
curl --fail --silent --show-error \
  "https://accounts.google.com/.well-known/openid-configuration" |
  node --input-type=module --eval '
    let body = "";
    for await (const chunk of process.stdin) body += chunk;
    const discovery = JSON.parse(body);

    if (discovery.issuer !== "https://accounts.google.com") {
      throw new Error("Google discovery returned an unexpected issuer");
    }

    for (const field of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
      const value = discovery[field];
      if (typeof value !== "string" || new URL(value).protocol !== "https:") {
        throw new Error("Google discovery is missing a secure " + field);
      }
    }
  '

curl --fail --silent --show-error "https://www.googleapis.com/oauth2/v3/certs" |
  node --input-type=module --eval '
    let body = "";
    for await (const chunk of process.stdin) body += chunk;
    const jwks = JSON.parse(body);
    if (!Array.isArray(jwks.keys) || jwks.keys.length === 0) {
      throw new Error("Google published no OIDC signing keys");
    }
  '

echo "PASS: Google publishes the fixed HTTPS issuer, protocol endpoints, and signing keys."
echo "All direct-Google authentication-foundation checks passed."
