#!/usr/bin/env bash

# Verify the live ZeroSheet direct-Google OIDC/BFF request boundary.
#
# PostgreSQL and the API must be running. The script stops before interactive
# Google authentication: it proves the authorization request, PKCE transaction,
# fail-closed callback, opaque cookie, and local logout behavior without reading
# a user's Google account or printing an OAuth client secret.

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
compose_file="${repository_root}/infra/compose.yaml"
environment_file="${repository_root}/.env"
verification_directory="$(mktemp -d)"

# The target is a concrete directory created immediately above. Cleaning it on
# every exit prevents authorization headers containing random transaction data
# from remaining in the operating system's temporary directory.
trap 'rm -rf -- "${verification_directory}"' EXIT

if [[ ! -f "${environment_file}" ]]; then
  echo "Missing ${environment_file}. Copy .env.example to .env first." >&2
  exit 1
fi

# A caller may point the verifier at a temporary port when another local
# project owns 3001. Capture that explicit override before sourcing `.env`;
# every other setting still comes from the repository's normal configuration.
api_base_url_override="${ZEROSHEET_API_URL:-}"
set -a
# shellcheck disable=SC1090 -- this is the repository-local ignored environment.
source "${environment_file}"
set +a
api_base_url="${api_base_url_override:-${ZEROSHEET_API_URL:-http://localhost:3001}}"

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

echo "PASS: product users, Google identities, one-time logins, and sessions are migrated."

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
    "${api_base_url}/auth/login/google"
)"

if [[ "${login_code}" != "302" ]]; then
  echo "FAIL: login did not redirect to Google." >&2
  exit 1
fi

for expected_header_fragment in \
  "location: https://accounts.google.com/o/oauth2/v2/auth" \
  "response_type=code" \
  "scope=openid+email+profile" \
  "state=" \
  "nonce=" \
  "code_challenge=" \
  "code_challenge_method=S256" \
  "prompt=select_account" \
  "set-cookie: zerosheet_oidc_transaction=" \
  "HttpOnly" \
  "SameSite=Lax"; do
  if ! grep --quiet "${expected_header_fragment}" "${verification_directory}/login.headers"; then
    echo "FAIL: login response is missing ${expected_header_fragment}." >&2
    exit 1
  fi
done

if grep --quiet 'kc_idp_hint' "${verification_directory}/login.headers"; then
  echo "FAIL: the direct Google request still contains a Keycloak broker hint." >&2
  exit 1
fi

# A valid-looking Google URL may still target a deleted/stale client. Compare
# the live request with the one configured client and actual API base; never
# print the authorization URL, whose state/nonce belong to a login transaction.
node --input-type=module - "${verification_directory}/login.headers" "${api_base_url}" <<'NODE'
import { readFileSync } from "node:fs";
const headers = readFileSync(process.argv[2], "utf8");
const location = headers.match(/^location:\s*(.+)$/im)?.[1]?.trim();
if (!location) throw new Error("Missing Google authorization redirect");
const url = new URL(location);
const callback = `${process.argv[3].replace(/\/$/, "")}/auth/callback`;
if (url.searchParams.get("client_id") !== process.env.GOOGLE_OAUTH_CLIENT_ID ||
    url.searchParams.get("redirect_uri") !== callback ||
    url.searchParams.has("client_secret")) {
  throw new Error("Google redirect does not match the shared client and callback configuration");
}
const storageEnabled = process.env.GOOGLE_STORAGE_OAUTH_ENABLED === "true";
const scopes = url.searchParams.get("scope")?.split(" ").sort();
const expectedScopes = ["openid", "email", "profile", ...(storageEnabled ? [
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/drive.appdata",
] : [])].sort();
if (JSON.stringify(scopes) !== JSON.stringify(expectedScopes) ||
    url.searchParams.get("prompt") !== (storageEnabled ? "select_account consent" : "select_account") ||
    (storageEnabled && (url.searchParams.get("access_type") !== "offline" ||
      url.searchParams.get("include_granted_scopes") !== "true"))) {
  throw new Error("Login consent parameters do not match the storage-enabled configuration");
}
console.log("PASS: login uses the configured shared Google client and exact callback, without exposing its secret.");
console.log(storageEnabled ? "PASS: one login requests identity plus offline Drive access." : "PASS: the storage-disabled lab requests identity only.");
NODE

# The request hint improves account selection, but the API independently checks
# the signed `hd` claim after callback before it creates a product session.
if [[ -n "${GOOGLE_OIDC_HOSTED_DOMAIN:-}" ]] &&
  ! grep --quiet "hd=${GOOGLE_OIDC_HOSTED_DOMAIN}" "${verification_directory}/login.headers"; then
  echo "FAIL: the configured Workspace-domain hint is missing." >&2
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
    --header 'Content-Type: application/x-www-form-urlencoded' \
    --data '' \
    --dump-header "${verification_directory}/logout.headers" \
    --output /dev/null \
    --write-out '%{http_code}' \
    "${api_base_url}/auth/logout"
)"

if [[ "${logout_code}" != "303" ]] ||
  ! grep --quiet "location: ${ZEROSHEET_WEB_URL}/" \
    "${verification_directory}/logout.headers" ||
  ! grep --quiet 'set-cookie: zerosheet_session=;' \
    "${verification_directory}/logout.headers"; then
  echo "FAIL: logout did not clear local state and return to ZeroSheet." >&2
  exit 1
fi

echo "PASS: API health and fail-closed anonymous session behavior are correct."
echo "PASS: an unbound callback is rejected without disclosing which validation failed."
echo "PASS: login uses Authorization Code, PKCE S256, state, nonce, and an HttpOnly SameSite cookie."
echo "PASS: the application talks directly to Google's fixed OIDC issuer with no broker hint."
echo "PASS: PostgreSQL stores the transaction cookie digest rather than relying on browser identity claims."
echo "PASS: browser-form logout clears only the ZeroSheet session and returns to the application."
