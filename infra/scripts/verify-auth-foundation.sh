#!/usr/bin/env bash

# This script proves the IAM foundation's security properties rather than merely
# checking that containers have started.
#
# A green Docker status cannot prove database isolation, realm discovery, JWKS
# publication, or correct OIDC client configuration. Each check below validates
# one of those behaviors and exits immediately when an invariant is broken.

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

# Export the documented values so curl checks and Docker Compose use exactly the
# same realm, ports, client ID, and database accounts.
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

assert_database_owner_can_connect "$KEYCLOAK_DB_USER" "$KEYCLOAK_DB_PASSWORD" "$KEYCLOAK_DB_NAME"

assert_database_owner_can_connect "$OPENFGA_DB_USER" "$OPENFGA_DB_PASSWORD" "$OPENFGA_DB_NAME"

assert_cross_database_connection_is_denied "$ZEROSHEET_DB_USER" "$ZEROSHEET_DB_PASSWORD" "$KEYCLOAK_DB_NAME"

assert_cross_database_connection_is_denied "$KEYCLOAK_DB_USER" "$KEYCLOAK_DB_PASSWORD" "$ZEROSHEET_DB_NAME"

assert_cross_database_connection_is_denied "$OPENFGA_DB_USER" "$OPENFGA_DB_PASSWORD" "$ZEROSHEET_DB_NAME"

echo "Verifying Keycloak health and OIDC metadata..."

curl --fail --silent --show-error "http://127.0.0.1:${KEYCLOAK_MANAGEMENT_PORT}/health/ready" >/dev/null

# Node parses the response instead of relying on grep. This ensures the endpoint
# returned valid JSON and that its issuer is exactly the value ZeroSheet will
# validate in Milestone 2.
curl --fail --silent --show-error "${KEYCLOAK_PUBLIC_URL}/realms/${KEYCLOAK_REALM}/.well-known/openid-configuration" |
  EXPECTED_ISSUER="${KEYCLOAK_PUBLIC_URL}/realms/${KEYCLOAK_REALM}" node --input-type=module --eval '
      let body = "";
      for await (const chunk of process.stdin) body += chunk;
      const discovery = JSON.parse(body);

      if (discovery.issuer !== process.env.EXPECTED_ISSUER) {
        throw new Error(
          "Unexpected issuer: " +
            discovery.issuer +
            "; expected " +
            process.env.EXPECTED_ISSUER,
        );
      }

      for (const field of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
        if (typeof discovery[field] !== "string" || discovery[field].length === 0) {
          throw new Error("OIDC discovery is missing " + field);
        }
      }
    '

curl --fail --silent --show-error "${KEYCLOAK_PUBLIC_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/certs" |
  node --input-type=module --eval '
    let body = "";
    for await (const chunk of process.stdin) body += chunk;
    const jwks = JSON.parse(body);

    if (!Array.isArray(jwks.keys) || jwks.keys.length === 0) {
      throw new Error("Keycloak published no signing keys");
    }
  '

# A valid client with an exact callback and PKCE challenge should render
# Keycloak's login page with HTTP 200. An unknown client should be rejected with
# HTTP 400. Checking both responses proves that the success page is tied to the
# imported BFF client rather than being a generic endpoint response.
authorization_arguments=(
  --silent
  --output /dev/null
  --write-out "%{http_code}"
  --get
  --data-urlencode "redirect_uri=$ZEROSHEET_API_URL/auth/callback"
  --data-urlencode "response_type=code"
  --data-urlencode "scope=openid profile email"
  --data-urlencode "state=verification-state"
  --data-urlencode "nonce=verification-nonce"
  --data-urlencode "code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
  --data-urlencode "code_challenge_method=S256"
)

authorization_url="$KEYCLOAK_PUBLIC_URL/realms/$KEYCLOAK_REALM/protocol/openid-connect/auth"

authorization_status_for_client() {
  local client_id="$1"

  curl "${authorization_arguments[@]}" --data-urlencode "client_id=$client_id" "$authorization_url"
}

valid_client_status="$(authorization_status_for_client "$KEYCLOAK_BFF_CLIENT_ID")"
invalid_client_status="$(authorization_status_for_client "unknown-client")"

if [[ "$valid_client_status" != "200" ]]; then
  echo "Expected the configured client to render login with 200; received $valid_client_status." >&2
  exit 1
fi

if [[ "$invalid_client_status" != "400" ]]; then
  echo "Expected an unknown client to be rejected with 400; received $invalid_client_status." >&2
  exit 1
fi

# The bootstrap administrator belongs to Keycloak's master realm and is used
# only to inspect local configuration. This password grant targets Keycloak's
# built-in admin-cli; it does not enable password grant on zerosheet-bff.
#
# The resulting access token is held only in shell memory, never printed, and
# unset immediately after the supported Admin API confirms the learner account.
admin_token_response="$(curl --fail --silent --show-error --request POST --data-urlencode "client_id=admin-cli" --data-urlencode "grant_type=password" --data-urlencode "username=$KEYCLOAK_ADMIN_USERNAME" --data-urlencode "password=$KEYCLOAK_ADMIN_PASSWORD" "$KEYCLOAK_PUBLIC_URL/realms/master/protocol/openid-connect/token")"

admin_token="$(printf "%s" "$admin_token_response" | node --input-type=module --eval '
  let body = "";
  for await (const chunk of process.stdin) body += chunk;
  const tokenResponse = JSON.parse(body);

  if (typeof tokenResponse.access_token !== "string") {
    throw new Error("Keycloak admin token response contained no access token");
  }

  process.stdout.write(tokenResponse.access_token);
')"

curl --fail --silent --show-error --get --header "Authorization: Bearer $admin_token" --data-urlencode "username=$KEYCLOAK_TEST_USER_USERNAME" --data-urlencode "exact=true" "$KEYCLOAK_PUBLIC_URL/admin/realms/$KEYCLOAK_REALM/users" |
  EXPECTED_USERNAME="$KEYCLOAK_TEST_USER_USERNAME" node --input-type=module --eval '
    let body = "";
    for await (const chunk of process.stdin) body += chunk;
    const users = JSON.parse(body);

    if (
      !Array.isArray(users) ||
      users.length !== 1 ||
      users[0]?.username !== process.env.EXPECTED_USERNAME
    ) {
      throw new Error("The imported learner account was not found");
    }
  '

unset admin_token admin_token_response

echo "PASS: Keycloak is ready, publishes valid OIDC metadata/JWKS, accepts the BFF client, rejects an unknown client, and retains the learner account."
echo "All authentication-foundation checks passed."
