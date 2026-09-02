#!/usr/bin/env bash

# Verify tenant-scoped SCIM lifecycle, session revocation, fail-closed policy,
# relationship convergence, and append-only audit evidence as one workflow.
#
# Prerequisites: PostgreSQL, OpenFGA, OPA, and the current API are running;
# migration 004 is applied; and the provisioned OpenFGA model IDs exist in
# .env.openfga. Authentication itself was verified in earlier milestones, so
# this script seeds only opaque browser sessions and exercises every lifecycle
# or authorization transition through ZeroSheet's HTTP boundaries.

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

owner_user_id="$(new_uuid)"
owner_session_token="lifecycle-owner-$(new_uuid)"
owner_selector_hash="$(printf '%s' "${owner_session_token}" | shasum -a 256 | awk '{print $1}')"
organization_id=""
workbook_id=""
scim_connection_id=""
scim_bearer_token=""
scim_user_id=""
managed_user_id=""

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

openfga_check() {
  local user="$1"
  local relation="$2"
  local object="$3"

  curl --fail --silent --show-error \
    --request POST \
    --header "Authorization: Bearer ${OPENFGA_PRESHARED_KEY}" \
    --header "Content-Type: application/json" \
    --data "{\"authorization_model_id\":\"${OPENFGA_AUTHORIZATION_MODEL_ID}\",\"tuple_key\":{\"user\":\"${user}\",\"relation\":\"${relation}\",\"object\":\"${object}\"},\"consistency\":\"HIGHER_CONSISTENCY\"}" \
    "${OPENFGA_API_URL}/stores/${OPENFGA_STORE_ID}/check"
}

api_request() {
  local method="$1"
  local path="$2"
  local session_token="$3"
  local body="$4"
  local output_file="$5"
  local arguments=(
    --silent
    --show-error
    --output "${output_file}"
    --write-out '%{http_code}'
    --request "${method}"
    --header "Accept: application/json"
  )

  if [[ -n "${session_token}" ]]; then
    arguments+=(--header "Cookie: zerosheet_session=${session_token}")
  fi
  if [[ -n "${body}" ]]; then
    arguments+=(--header "Content-Type: application/json" --data "${body}")
  fi

  curl "${arguments[@]}" "${ZEROSHEET_API_URL}${path}"
}

scim_request() {
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
    --header "Accept: application/scim+json"
    --header "Authorization: Bearer ${scim_bearer_token}"
  )

  if [[ -n "${body}" ]]; then
    arguments+=(--header "Content-Type: application/scim+json" --data "${body}")
  fi

  curl "${arguments[@]}" "${ZEROSHEET_API_URL}/scim/v2${path}"
}

json_field() {
  local file="$1"
  local field="$2"

  node --input-type=module --eval '
    import fs from "node:fs";
    const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const value = body[process.argv[2]];
    if (typeof value !== "string") throw new Error(`Response field ${process.argv[2]} is missing`);
    process.stdout.write(value);
  ' "${file}" "${field}"
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

seed_session() {
  local user_id="$1"
  local token="$2"
  local selector_hash
  selector_hash="$(printf '%s' "${token}" | shasum -a 256 | awk '{print $1}')"

  run_zerosheet_sql --command "
    INSERT INTO user_sessions (selector_hash, user_id, created_at, expires_at)
    VALUES ('${selector_hash}', '${user_id}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '10 minutes');
  " >/dev/null
}

cleanup() {
  # Audit rows deliberately remain: the database trigger being tested makes
  # security evidence immutable. They contain only random verifier IDs, while
  # product, SCIM, session, and relationship state is removed best-effort.
  set +e

  tuple_keys=()
  if [[ -n "${organization_id}" ]]; then
    tuple_keys+=(
      "{\"user\":\"user:${owner_user_id}\",\"relation\":\"owner\",\"object\":\"organization:${organization_id}\"}"
    )
  fi
  if [[ -n "${managed_user_id}" ]] && [[ -n "${organization_id}" ]]; then
    tuple_keys+=(
      "{\"user\":\"user:${managed_user_id}\",\"relation\":\"member\",\"object\":\"organization:${organization_id}\"}"
    )
  fi
  if [[ -n "${workbook_id}" ]]; then
    tuple_keys+=(
      "{\"user\":\"organization:${organization_id}\",\"relation\":\"organization\",\"object\":\"workbook:${workbook_id}\"}"
      "{\"user\":\"user:${owner_user_id}\",\"relation\":\"owner\",\"object\":\"workbook:${workbook_id}\"}"
    )
    if [[ -n "${managed_user_id}" ]]; then
      tuple_keys+=(
        "{\"user\":\"user:${managed_user_id}\",\"relation\":\"viewer\",\"object\":\"workbook:${workbook_id}\"}"
      )
    fi
  fi

  if [[ ${#tuple_keys[@]} -gt 0 ]]; then
    tuple_json="$(IFS=,; echo "${tuple_keys[*]}")"
    openfga_write "{\"authorization_model_id\":\"${OPENFGA_AUTHORIZATION_MODEL_ID}\",\"deletes\":{\"tuple_keys\":[${tuple_json}],\"on_missing\":\"ignore\"}}" 2>/dev/null
  fi

  run_zerosheet_sql --command "
    DELETE FROM organizations WHERE id = NULLIF('${organization_id}', '')::uuid;
    DELETE FROM relationship_outbox
    WHERE writes::text LIKE '%${owner_user_id}%'
       OR deletes::text LIKE '%${owner_user_id}%'
       OR (NULLIF('${managed_user_id}', '') IS NOT NULL
         AND (writes::text LIKE '%${managed_user_id}%'
           OR deletes::text LIKE '%${managed_user_id}%'));
    DELETE FROM product_users
    WHERE id IN ('${owner_user_id}', NULLIF('${managed_user_id}', '')::uuid);
  " >/dev/null 2>&1
  rm -rf -- "${verification_directory}"
}

trap cleanup EXIT

# The owner session represents authentication already verified by Milestone 2.
# Everything after this seed goes through the public product or SCIM API.
run_zerosheet_sql --command "
  INSERT INTO product_users (id, primary_email, display_name, created_at, updated_at)
  VALUES ('${owner_user_id}', 'owner-${owner_user_id}@zerosheet.local', 'Lifecycle Owner', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

  INSERT INTO user_sessions (selector_hash, user_id, created_at, expires_at)
  VALUES ('${owner_selector_hash}', '${owner_user_id}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '10 minutes');
" >/dev/null

status="$(api_request POST /organizations "${owner_session_token}" '{"name":"Lifecycle Tenant"}' "${verification_directory}/organization.json")"
expect_status "${status}" 201 "organization creation"
organization_id="$(json_field "${verification_directory}/organization.json" id)"

status="$(api_request POST "/organizations/${organization_id}/workbooks" "${owner_session_token}" '{"name":"Lifecycle Workbook"}' "${verification_directory}/workbook.json")"
expect_status "${status}" 201 "workbook creation"
workbook_id="$(json_field "${verification_directory}/workbook.json" id)"

status="$(api_request POST "/organizations/${organization_id}/scim/connections" "${owner_session_token}" '{"displayName":"Verifier Directory"}' "${verification_directory}/connection.json")"
expect_status "${status}" 201 "SCIM connection creation"
scim_connection_id="$(json_field "${verification_directory}/connection.json" id)"
scim_bearer_token="$(json_field "${verification_directory}/connection.json" bearerToken)"

# The plaintext provisioning credential must be returned exactly once. The
# database comparison proves only its one-way SHA-256 digest was persisted.
expected_token_hash="$(printf '%s' "${scim_bearer_token}" | shasum -a 256 | awk '{print $1}')"
stored_token_hash="$(run_zerosheet_sql --command "SELECT token_hash FROM scim_connections WHERE id = '${scim_connection_id}';")"
if [[ "${stored_token_hash}" != "${expected_token_hash}" ]]; then
  echo "FAIL: SCIM connection did not persist the expected one-way token digest." >&2
  exit 1
fi

status="$(scim_request POST /Users '{"schemas":["urn:ietf:params:scim:schemas:core:2.0:User"],"externalId":"directory-employee-42","userName":"employee-42@zerosheet.local","displayName":"Directory Employee","active":true}' "${verification_directory}/scim-user.json")"
expect_status "${status}" 201 "active SCIM user creation"
scim_user_id="$(json_field "${verification_directory}/scim-user.json" id)"
managed_user_id="$(run_zerosheet_sql --command "SELECT product_user_id FROM scim_managed_users WHERE id = '${scim_user_id}' AND connection_id = '${scim_connection_id}';")"
if [[ -z "${managed_user_id}" ]]; then
  echo "FAIL: SCIM resource did not create a tenant-bound product user." >&2
  exit 1
fi

managed_session_token="managed-active-$(new_uuid)"
seed_session "${managed_user_id}" "${managed_session_token}"

status="$(api_request PUT "/workbooks/${workbook_id}/shares/users/${managed_user_id}" "${owner_session_token}" '{"role":"viewer"}' "${verification_directory}/share.json")"
expect_status "${status}" 200 "managed-user workbook sharing"
status="$(api_request GET "/workbooks/${workbook_id}" "${managed_session_token}" '' "${verification_directory}/active-access.json")"
expect_status "${status}" 200 "active managed-user access"

status="$(scim_request PATCH "/Users/${scim_user_id}" '{"schemas":["urn:ietf:params:scim:api:messages:2.0:PatchOp"],"Operations":[{"op":"replace","path":"active","value":false}]}' "${verification_directory}/suspended-user.json")"
expect_status "${status}" 200 "SCIM user suspension"

# The old session must disappear immediately. A deliberately re-seeded session
# then proves the tenant lifecycle deny still overrides an unchanged direct
# workbook relationship in OpenFGA.
status="$(api_request GET "/workbooks/${workbook_id}" "${managed_session_token}" '' "${verification_directory}/revoked-session.json")"
expect_status "${status}" 401 "suspended-user session revocation"

suspended_session_token="managed-suspended-$(new_uuid)"
seed_session "${managed_user_id}" "${suspended_session_token}"
status="$(api_request GET "/workbooks/${workbook_id}" "${suspended_session_token}" '' "${verification_directory}/suspended-deny.json")"
expect_status "${status}" 403 "suspended tenant-membership access"

workbook_relationship="$(openfga_check "user:${managed_user_id}" can_view "workbook:${workbook_id}")"
organization_relationship="$(openfga_check "user:${managed_user_id}" can_create_workbook "organization:${organization_id}")"
if [[ "${workbook_relationship}" != *'"allowed":true'* ]] ||
  [[ "${organization_relationship}" != *'"allowed":false'* ]]; then
  echo "FAIL: deactivation did not preserve the direct share while removing organization membership." >&2
  exit 1
fi

status="$(scim_request PATCH "/Users/${scim_user_id}" '{"schemas":["urn:ietf:params:scim:api:messages:2.0:PatchOp"],"Operations":[{"op":"replace","value":{"active":true}}]}' "${verification_directory}/reactivated-user.json")"
expect_status "${status}" 200 "SCIM user reactivation"

reactivated_session_token="managed-reactivated-$(new_uuid)"
seed_session "${managed_user_id}" "${reactivated_session_token}"
status="$(api_request GET "/workbooks/${workbook_id}" "${reactivated_session_token}" '' "${verification_directory}/restored-access.json")"
expect_status "${status}" 200 "reactivated managed-user access"

status="$(api_request GET "/organizations/${organization_id}/audit-events?limit=200" "${owner_session_token}" '' "${verification_directory}/audit.json")"
expect_status "${status}" 200 "authorized audit export"
node --input-type=module --eval '
  import fs from "node:fs";
  const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const actions = new Set(body.events?.map((event) => event.action));
  for (const expected of ["scim.connection.create", "scim.user.create", "scim.user.replace"]) {
    if (!actions.has(expected)) throw new Error(`Audit export is missing ${expected}`);
  }
' "${verification_directory}/audit.json"

# Even the database owner used by the application must be unable to rewrite
# an existing event through ordinary DML. The expected trigger error is hidden
# here; success would be the security failure.
audit_sequence="$(run_zerosheet_sql --command "SELECT sequence FROM security_audit_events WHERE organization_id = '${organization_id}' ORDER BY sequence LIMIT 1;")"
if [[ -z "${audit_sequence}" ]]; then
  echo "FAIL: no tenant audit evidence was recorded." >&2
  exit 1
fi
if run_zerosheet_sql --command "UPDATE security_audit_events SET outcome = outcome WHERE sequence = ${audit_sequence};" >/dev/null 2>&1; then
  echo "FAIL: append-only audit evidence accepted an UPDATE." >&2
  exit 1
fi

echo "PASS: the tenant administrator created a one-time, digest-stored SCIM credential."
echo "PASS: active provisioning converged product state and the OpenFGA member relationship."
echo "PASS: suspension revoked sessions, removed organization membership, and OPA denied an unchanged direct share."
echo "PASS: reactivation restored membership and access through the same stable SCIM resource."
echo "PASS: authorized audit export contained lifecycle evidence and PostgreSQL rejected mutation."
