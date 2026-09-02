#!/usr/bin/env bash

# Verify that contextual status can deny access without deleting relationships.
#
# Prerequisites: PostgreSQL, OpenFGA, OPA, and the current API are running, the
# OpenFGA model is provisioned, and every migration is applied. The verifier
# seeds only authentication state directly; product resources are created via
# public APIs. It then changes PIP facts in PostgreSQL and proves the API denies
# while OpenFGA continues to allow the unchanged owner relationship.

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
compose_file="${repository_root}/infra/compose.yaml"
environment_file="${repository_root}/.env"
openfga_environment_file="${repository_root}/.env.openfga"
verification_directory="$(mktemp -d)"

if [[ ! -f "${environment_file}" ]] ||
  [[ ! -f "${openfga_environment_file}" ]]; then
  echo "Missing .env or .env.openfga; start and provision the authorization stack first." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090 -- local developer configuration is intentional.
source "${environment_file}"
# shellcheck disable=SC1090 -- generated OpenFGA IDs are machine-local.
source "${openfga_environment_file}"
set +a

new_uuid() {
  node --input-type=module --eval 'console.log(crypto.randomUUID())'
}

user_id="$(new_uuid)"
session_token="contextual-owner-$(new_uuid)"
selector_hash="$(printf '%s' "${session_token}" | shasum -a 256 | awk '{print $1}')"
organization_id=""
workbook_id=""

run_zerosheet_sql() {
  docker compose \
    --env-file "${environment_file}" \
    --file "${compose_file}" \
    exec --no-TTY postgres \
    sh -c 'PGPASSWORD="$ZEROSHEET_DB_PASSWORD" exec psql --tuples-only --no-align --set=ON_ERROR_STOP=1 --username "$ZEROSHEET_DB_USER" --dbname "$ZEROSHEET_DB_NAME" "$@"' \
    sh \
    "$@"
}

openfga_write() {
  local body="$1"

  curl --fail --silent --show-error \
    --request POST \
    --header "Authorization: Bearer ${OPENFGA_PRESHARED_KEY}" \
    --header "Content-Type: application/json" \
    --data "${body}" \
    "${OPENFGA_API_URL}/stores/${OPENFGA_STORE_ID}/write" \
    >/dev/null
}

api_request() {
  local method="$1"
  local path="$2"
  local body="$3"
  local output_file="$4"
  local arguments=(
    --silent
    --show-error
    --output "${output_file}"
    --write-out '%{http_code}'
    --request "${method}"
    --header "Accept: application/json"
    --header "Cookie: zerosheet_session=${session_token}"
  )

  if [[ -n "${body}" ]]; then
    arguments+=(--header "Content-Type: application/json" --data "${body}")
  fi

  curl "${arguments[@]}" "${ZEROSHEET_API_URL}${path}"
}

json_id() {
  node --input-type=module --eval '
    import fs from "node:fs";
    const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (typeof body.id !== "string") throw new Error("Response has no id");
    process.stdout.write(body.id);
  ' "$1"
}

expect_status() {
  local actual="$1"
  local expected="$2"
  local action="$3"

  if [[ "${actual}" != "${expected}" ]]; then
    echo "FAIL: ${action} returned HTTP ${actual}; expected ${expected}." >&2
    exit 1
  fi
}

cleanup() {
  # Cleanup is best effort and must not hide the original failure. OpenFGA
  # deletes use Ignore because an interrupted run may have written only some
  # of the tuples assembled below.
  set +e

  tuple_keys=()
  if [[ -n "${organization_id}" ]]; then
    tuple_keys+=(
      "{\"user\":\"user:${user_id}\",\"relation\":\"owner\",\"object\":\"organization:${organization_id}\"}"
    )
  fi
  if [[ -n "${workbook_id}" ]]; then
    tuple_keys+=(
      "{\"user\":\"organization:${organization_id}\",\"relation\":\"organization\",\"object\":\"workbook:${workbook_id}\"}"
      "{\"user\":\"user:${user_id}\",\"relation\":\"owner\",\"object\":\"workbook:${workbook_id}\"}"
    )
  fi

  if [[ ${#tuple_keys[@]} -gt 0 ]]; then
    tuple_json="$(IFS=,; echo "${tuple_keys[*]}")"
    openfga_write "{\"authorization_model_id\":\"${OPENFGA_AUTHORIZATION_MODEL_ID}\",\"deletes\":{\"tuple_keys\":[${tuple_json}],\"on_missing\":\"ignore\"}}" 2>/dev/null
  fi

  run_zerosheet_sql --command "
    UPDATE product_users SET account_status = 'active' WHERE id = '${user_id}';
    DELETE FROM organizations WHERE id = NULLIF('${organization_id}', '')::uuid;
    DELETE FROM relationship_outbox
    WHERE writes::text LIKE '%${user_id}%'
       OR deletes::text LIKE '%${user_id}%';
    DELETE FROM product_users WHERE id = '${user_id}';
  " >/dev/null 2>&1
  rm -rf -- "${verification_directory}"
}

trap cleanup EXIT

# Authentication is outside this verifier, so it seeds one opaque session.
# Account and tenant statuses use their migration defaults (`active`).
run_zerosheet_sql --command "
  INSERT INTO product_users (id, primary_email, display_name, created_at, updated_at)
  VALUES ('${user_id}', 'context-${user_id}@zerosheet.local', 'Context Verifier', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

  INSERT INTO user_sessions (selector_hash, user_id, created_at, expires_at)
  VALUES ('${selector_hash}', '${user_id}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '10 minutes');
" >/dev/null

status="$(api_request POST /organizations '{"name":"Context Policy"}' "${verification_directory}/organization.json")"
expect_status "${status}" 201 "active-account organization creation"
organization_id="$(json_id "${verification_directory}/organization.json")"

status="$(api_request POST "/organizations/${organization_id}/workbooks" '{"name":"Policy Workbook"}' "${verification_directory}/workbook.json")"
expect_status "${status}" 201 "active-tenant workbook creation"
workbook_id="$(json_id "${verification_directory}/workbook.json")"

status="$(api_request GET "/workbooks/${workbook_id}" '' "${verification_directory}/initial-allow.json")"
expect_status "${status}" 200 "active-context workbook access"

# Suspending the tenant changes only PostgreSQL context. The owner tuple remains
# present, proving OPA—not relationship deletion—is responsible for the denial.
run_zerosheet_sql --command \
  "UPDATE organizations SET tenant_status = 'suspended' WHERE id = '${organization_id}';" \
  >/dev/null

openfga_allowed="$(curl --fail --silent --show-error \
  --request POST \
  --header "Authorization: Bearer ${OPENFGA_PRESHARED_KEY}" \
  --header "Content-Type: application/json" \
  --data "{\"authorization_model_id\":\"${OPENFGA_AUTHORIZATION_MODEL_ID}\",\"tuple_key\":{\"user\":\"user:${user_id}\",\"relation\":\"can_view\",\"object\":\"workbook:${workbook_id}\"},\"consistency\":\"HIGHER_CONSISTENCY\"}" \
  "${OPENFGA_API_URL}/stores/${OPENFGA_STORE_ID}/check")"

if [[ "${openfga_allowed}" != *'"allowed":true'* ]]; then
  echo "FAIL: the unchanged OpenFGA owner relationship was not allowed." >&2
  exit 1
fi

status="$(api_request GET "/workbooks/${workbook_id}" '' "${verification_directory}/tenant-deny.json")"
expect_status "${status}" 403 "suspended-tenant workbook access"

run_zerosheet_sql --command "
  UPDATE organizations SET tenant_status = 'active' WHERE id = '${organization_id}';
  UPDATE product_users SET account_status = 'suspended' WHERE id = '${user_id}';
" >/dev/null

status="$(api_request GET "/workbooks/${workbook_id}" '' "${verification_directory}/account-deny.json")"
expect_status "${status}" 403 "suspended-account workbook access"
status="$(api_request POST /organizations '{"name":"Must Be Denied"}' "${verification_directory}/create-deny.json")"
expect_status "${status}" 403 "suspended-account organization creation"

run_zerosheet_sql --command \
  "UPDATE product_users SET account_status = 'active' WHERE id = '${user_id}';" \
  >/dev/null
status="$(api_request GET "/workbooks/${workbook_id}" '' "${verification_directory}/restored-allow.json")"
expect_status "${status}" 200 "reactivated-context workbook access"

echo "PASS: active account and tenant context allowed the OpenFGA owner."
echo "PASS: tenant suspension denied access while the owner relationship remained allowed."
echo "PASS: account suspension denied existing access and new organization creation."
echo "PASS: reactivation restored access without recreating any OpenFGA tuple."
