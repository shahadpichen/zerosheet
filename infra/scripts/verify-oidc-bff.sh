#!/usr/bin/env bash

# Verify the first real ZeroSheet OIDC/BFF request boundary.
#
# Prerequisites are intentionally explicit: PostgreSQL and Keycloak must be up,
# the API must be running, and `.env` must exist. The script does not automate a
# user's password entry; instead it proves everything up to Keycloak's login UI
# and leaves the interactive authentication ceremony to the browser.

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
compose_file="${repository_root}/infra/compose.yaml"
environment_file="${repository_root}/.env"
api_base_url="${ZEROSHEET_API_URL:-http://127.0.0.1:3001}"
verification_directory="$(mktemp -d)"

# The target is a concrete directory created immediately above. Cleaning it on
# every exit prevents authorization headers containing random transaction data
# from remaining in the operating system's temporary directory.
trap 'rm -rf -- "${verification_directory}"' EXIT

if [[ ! -f "${environment_file}" ]]; then
  echo "Missing ${environment_file}. Copy .env.example to .env first." >&2
  exit 1
fi

"${repository_root}/infra/scripts/migrate-zerosheet-database.sh" >/dev/null

run_zerosheet_sql() {
  docker compose \
    --env-file "${environment_file}" \
    --file "${compose_file}" \
    exec --no-TTY postgres \
    sh -c 'PGPASSWORD="$ZEROSHEET_DB_PASSWORD" exec psql --tuples-only --no-align --set=ON_ERROR_STOP=1 --username "$ZEROSHEET_DB_USER" --dbname "$ZEROSHEET_DB_NAME" "$@"' \
    sh \
    "$@"
}

echo "Verifying the ZeroSheet-owned authentication schema..."

migration_present="$(
  run_zerosheet_sql --command \
    "SELECT count(*) FROM schema_migrations WHERE version = '001_oidc_bff_authentication'"
)"

if [[ "${migration_present}" != "1" ]]; then
  echo "FAIL: OIDC BFF migration was not recorded." >&2
  exit 1
fi

for table in product_users external_identities oidc_login_transactions user_sessions; do
  table_present="$(
    run_zerosheet_sql --command \
      "SELECT CASE WHEN to_regclass('public.${table}') IS NULL THEN 0 ELSE 1 END"
  )"

  if [[ "${table_present}" != "1" ]]; then
    echo "FAIL: expected table ${table} does not exist." >&2
    exit 1
  fi
done

echo "PASS: product users, external identities, one-time logins, and sessions are migrated."

echo "Verifying the live API/BFF boundary..."

health_code="$(
  curl --silent --show-error \
    --output "${verification_directory}/health.json" \
    --write-out '%{http_code}' \
    "${api_base_url}/health"
)"

if [[ "${health_code}" != "200" ]] ||
  ! grep --quiet '"status":"ok"' "${verification_directory}/health.json"; then
  echo "FAIL: ZeroSheet API health check did not succeed." >&2
  exit 1
fi

anonymous_code="$(
  curl --silent --show-error \
    --output "${verification_directory}/anonymous.json" \
    --write-out '%{http_code}' \
    "${api_base_url}/auth/me"
)"

if [[ "${anonymous_code}" != "401" ]] ||
  ! grep --quiet '"authenticated":false' "${verification_directory}/anonymous.json"; then
  echo "FAIL: anonymous session check did not fail closed with HTTP 401." >&2
  exit 1
fi

invalid_callback_code="$(
  curl --silent --show-error \
    --output "${verification_directory}/invalid-callback.json" \
    --write-out '%{http_code}' \
    "${api_base_url}/auth/callback?code=untrusted-code&state=untrusted-state"
)"

if [[ "${invalid_callback_code}" != "400" ]] ||
  ! grep --quiet '"error":"authentication_failed"' \
    "${verification_directory}/invalid-callback.json"; then
  echo "FAIL: an unbound callback was not rejected with the generic authentication error." >&2
  exit 1
fi

login_code="$(
  curl --silent --show-error \
    --dump-header "${verification_directory}/login.headers" \
    --output /dev/null \
    --write-out '%{http_code}' \
    "${api_base_url}/auth/login"
)"

if [[ "${login_code}" != "302" ]]; then
  echo "FAIL: login did not redirect to Keycloak." >&2
  exit 1
fi

for expected_header_fragment in \
  "location: http://localhost:8080/realms/zerosheet/protocol/openid-connect/auth" \
  "response_type=code" \
  "scope=openid+email+profile" \
  "state=" \
  "nonce=" \
  "code_challenge=" \
  "code_challenge_method=S256" \
  "set-cookie: zerosheet_oidc_transaction=" \
  "HttpOnly" \
  "SameSite=Lax"; do
  if ! grep --quiet "${expected_header_fragment}" "${verification_directory}/login.headers"; then
    echo "FAIL: login response is missing ${expected_header_fragment}." >&2
    exit 1
  fi
done

# The Google-specific route must create the same protected transaction while
# adding only Keycloak's fixed broker hint. This is a shortcut through Keycloak,
# not a second OAuth implementation inside ZeroSheet.
google_login_code="$(
  curl --silent --show-error \
    --dump-header "${verification_directory}/google-login.headers" \
    --output /dev/null \
    --write-out '%{http_code}' \
    "${api_base_url}/auth/login/google"
)"

if [[ "${google_login_code}" != "302" ]] ||
  ! grep --quiet 'kc_idp_hint=google' \
    "${verification_directory}/google-login.headers" ||
  ! grep --quiet 'set-cookie: zerosheet_oidc_transaction=' \
    "${verification_directory}/google-login.headers" ||
  ! grep --quiet 'HttpOnly' \
    "${verification_directory}/google-login.headers"; then
  echo "FAIL: Google login did not use the protected Keycloak broker flow." >&2
  exit 1
fi

# Extract the cookie locally, hash it, and prove PostgreSQL contains the digest.
# Neither the raw transaction cookie nor its state/nonce is printed.
transaction_token="$(
  sed -n 's/^set-cookie: zerosheet_oidc_transaction=\([^;]*\).*/\1/ip' \
    "${verification_directory}/login.headers"
)"
selector_hash="$(printf '%s' "${transaction_token}" | shasum -a 256 | awk '{print $1}')"

# Only a locally computed 64-character hexadecimal digest may be embedded in
# the diagnostic SQL below. This validation keeps shell-derived data from ever
# becoming executable SQL syntax.
if [[ ! "${selector_hash}" =~ ^[0-9a-f]{64}$ ]]; then
  echo "FAIL: transaction selector digest has an unexpected format." >&2
  exit 1
fi

matching_selector="$(
  run_zerosheet_sql --command \
    "SELECT count(*) FROM oidc_login_transactions WHERE selector_hash = '${selector_hash}'"
)"

if [[ -z "${transaction_token}" ]] || [[ "${matching_selector}" != "1" ]]; then
  echo "FAIL: PostgreSQL did not retain the digest for the issued transaction cookie." >&2
  exit 1
fi

logout_code="$(
  curl --silent --show-error \
    --request POST \
    --dump-header "${verification_directory}/logout.headers" \
    --output /dev/null \
    --write-out '%{http_code}' \
    "${api_base_url}/auth/logout"
)"

if [[ "${logout_code}" != "303" ]] ||
  ! grep --quiet \
    'location: http://localhost:8080/realms/zerosheet/protocol/openid-connect/logout' \
    "${verification_directory}/logout.headers" ||
  ! grep --quiet 'client_id=zerosheet-bff' \
    "${verification_directory}/logout.headers" ||
  ! grep --quiet 'post_logout_redirect_uri=' \
    "${verification_directory}/logout.headers"; then
  echo "FAIL: logout did not clear local state through the registered Keycloak flow." >&2
  exit 1
fi

echo "PASS: API health and fail-closed anonymous session behavior are correct."
echo "PASS: an unbound callback is rejected without disclosing which validation failed."
echo "PASS: login uses Authorization Code, PKCE S256, state, nonce, and an HttpOnly SameSite cookie."
echo "PASS: Google login adds only the reviewed Keycloak broker hint and retains the protected transaction."
echo "PASS: PostgreSQL stores the transaction cookie digest rather than relying on browser identity claims."
echo "PASS: logout redirects through Keycloak with the registered client and destination."
