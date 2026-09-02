#!/usr/bin/env bash

# Verify product metadata and OpenFGA relationship mutations as one lifecycle.
#
# Prerequisites: PostgreSQL, OpenFGA, and the API are running, and migrations
# have been applied. The script creates three temporary product users and
# sessions, performs only public API calls for the actual lifecycle, proves
# inherited and direct access plus revocation, then removes all temporary state.

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
member_user_id="$(new_uuid)"
external_user_id="$(new_uuid)"
owner_session_token="product-owner-$(new_uuid)"
member_session_token="product-member-$(new_uuid)"
external_session_token="product-external-$(new_uuid)"
owner_selector_hash="$(printf '%s' "${owner_session_token}" | shasum -a 256 | awk '{print $1}')"
member_selector_hash="$(printf '%s' "${member_session_token}" | shasum -a 256 | awk '{print $1}')"
external_selector_hash="$(printf '%s' "${external_session_token}" | shasum -a 256 | awk '{print $1}')"
organization_id=""
team_id=""
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

json_id() {
  node --input-type=module --eval '
    import fs from "node:fs";
    const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (typeof body.id !== "string") throw new Error("Response has no id");
    process.stdout.write(body.id);
  ' "$1"
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
  # Cleanup is best effort and must never hide the verification failure. Tuple
  # deletion uses Ignore because successful API revocations already removed
  # some relationships and an interrupted request can leave only a subset.
  set +e

  if [[ -n "${organization_id}" ]]; then
    tuple_keys=(
      "{\"user\":\"user:${owner_user_id}\",\"relation\":\"owner\",\"object\":\"organization:${organization_id}\"}"
      "{\"user\":\"user:${member_user_id}\",\"relation\":\"member\",\"object\":\"organization:${organization_id}\"}"
    )

    if [[ -n "${team_id}" ]]; then
      tuple_keys+=(
        "{\"user\":\"organization:${organization_id}\",\"relation\":\"organization\",\"object\":\"team:${team_id}\"}"
        "{\"user\":\"user:${owner_user_id}\",\"relation\":\"manager\",\"object\":\"team:${team_id}\"}"
        "{\"user\":\"user:${member_user_id}\",\"relation\":\"member\",\"object\":\"team:${team_id}\"}"
      )
    fi

    if [[ -n "${workbook_id}" ]]; then
      tuple_keys+=(
        "{\"user\":\"organization:${organization_id}\",\"relation\":\"organization\",\"object\":\"workbook:${workbook_id}\"}"
        "{\"user\":\"user:${owner_user_id}\",\"relation\":\"owner\",\"object\":\"workbook:${workbook_id}\"}"
        "{\"user\":\"team:${team_id}#member\",\"relation\":\"editor\",\"object\":\"workbook:${workbook_id}\"}"
        "{\"user\":\"user:${external_user_id}\",\"relation\":\"viewer\",\"object\":\"workbook:${workbook_id}\"}"
      )
    fi

    tuple_json="$(IFS=,; echo "${tuple_keys[*]}")"
    openfga_write "{\"authorization_model_id\":\"${OPENFGA_AUTHORIZATION_MODEL_ID}\",\"deletes\":{\"tuple_keys\":[${tuple_json}],\"on_missing\":\"ignore\"}}" 2>/dev/null
  fi

  run_zerosheet_sql --command "
    DELETE FROM organizations WHERE id = NULLIF('${organization_id}', '')::uuid;
    DELETE FROM relationship_outbox
    WHERE writes::text LIKE '%${owner_user_id}%'
       OR deletes::text LIKE '%${owner_user_id}%'
       OR writes::text LIKE '%${member_user_id}%'
       OR deletes::text LIKE '%${member_user_id}%'
       OR writes::text LIKE '%${external_user_id}%'
       OR deletes::text LIKE '%${external_user_id}%';
    DELETE FROM product_users
    WHERE id IN ('${owner_user_id}', '${member_user_id}', '${external_user_id}');
  " >/dev/null 2>&1
  rm -rf -- "${verification_directory}"
}

trap cleanup EXIT

# Sessions are seeded directly because this verifier tests the boundary after
# authentication. Product resources and every relationship use public APIs.
run_zerosheet_sql --command "
  INSERT INTO product_users (id, primary_email, display_name, created_at, updated_at)
  VALUES
    ('${owner_user_id}', 'owner-${owner_user_id}@zerosheet.local', 'Lifecycle Owner', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('${member_user_id}', 'member-${member_user_id}@zerosheet.local', 'Lifecycle Member', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('${external_user_id}', 'external-${external_user_id}@zerosheet.local', 'Lifecycle External', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

  INSERT INTO user_sessions (selector_hash, user_id, created_at, expires_at)
  VALUES
    ('${owner_selector_hash}', '${owner_user_id}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '10 minutes'),
    ('${member_selector_hash}', '${member_user_id}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '10 minutes'),
    ('${external_selector_hash}', '${external_user_id}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '10 minutes');
" >/dev/null

status="$(api_request POST /organizations "${owner_session_token}" '{"name":"Acme Lifecycle"}' "${verification_directory}/organization.json")"
expect_status "${status}" 201 "organization creation"
organization_id="$(json_id "${verification_directory}/organization.json")"

status="$(api_request PUT "/organizations/${organization_id}/members/${member_user_id}" "${owner_session_token}" '{"role":"member"}' "${verification_directory}/organization-member.json")"
expect_status "${status}" 200 "organization membership creation"

status="$(api_request POST "/organizations/${organization_id}/teams" "${owner_session_token}" '{"name":"Finance"}' "${verification_directory}/team.json")"
expect_status "${status}" 201 "team creation"
team_id="$(json_id "${verification_directory}/team.json")"

status="$(api_request PUT "/teams/${team_id}/members/${member_user_id}" "${owner_session_token}" '{"role":"member"}' "${verification_directory}/team-member.json")"
expect_status "${status}" 200 "team membership creation"

status="$(api_request POST "/organizations/${organization_id}/workbooks" "${owner_session_token}" '{"name":"Budget"}' "${verification_directory}/workbook.json")"
expect_status "${status}" 201 "workbook creation"
workbook_id="$(json_id "${verification_directory}/workbook.json")"

status="$(api_request PUT "/workbooks/${workbook_id}/shares/teams/${team_id}" "${owner_session_token}" '{"role":"editor"}' "${verification_directory}/team-share.json")"
expect_status "${status}" 200 "team workbook sharing"

status="$(api_request GET "/workbooks/${workbook_id}" "${member_session_token}" '' "${verification_directory}/member-allowed.json")"
expect_status "${status}" 200 "inherited team workbook access"

status="$(api_request GET "/workbooks/${workbook_id}" "${external_session_token}" '' "${verification_directory}/external-denied.json")"
expect_status "${status}" 403 "unrelated user denial"

status="$(api_request DELETE "/organizations/${organization_id}/members/${member_user_id}" "${owner_session_token}" '' "${verification_directory}/member-removed.json")"
expect_status "${status}" 204 "organization member removal"

status="$(api_request GET "/workbooks/${workbook_id}" "${member_session_token}" '' "${verification_directory}/member-revoked.json")"
expect_status "${status}" 403 "cascaded team revocation"

status="$(api_request PUT "/workbooks/${workbook_id}/shares/users/${external_user_id}" "${owner_session_token}" '{"role":"viewer"}' "${verification_directory}/direct-share.json")"
expect_status "${status}" 200 "direct external share"

status="$(api_request GET "/workbooks/${workbook_id}" "${external_session_token}" '' "${verification_directory}/external-allowed.json")"
expect_status "${status}" 200 "direct external workbook access"

status="$(api_request DELETE "/workbooks/${workbook_id}/shares/users/${external_user_id}" "${owner_session_token}" '' "${verification_directory}/direct-share-removed.json")"
expect_status "${status}" 204 "direct share removal"

status="$(api_request GET "/workbooks/${workbook_id}" "${external_session_token}" '' "${verification_directory}/external-revoked.json")"
expect_status "${status}" 403 "direct share revocation"

status="$(api_request POST /organizations '' '{"name":"Anonymous"}' "${verification_directory}/anonymous.json")"
expect_status "${status}" 401 "anonymous mutation"

pending_count="$(run_zerosheet_sql --command "
  SELECT count(*)
  FROM relationship_outbox
  WHERE status = 'pending'
    AND (writes::text LIKE '%${organization_id}%'
      OR deletes::text LIKE '%${organization_id}%');
")"
team_member_count="$(run_zerosheet_sql --command "
  SELECT count(*)
  FROM team_members
  WHERE team_id = '${team_id}' AND user_id = '${member_user_id}';
")"

if [[ "${pending_count}" != "0" ]] || [[ "${team_member_count}" != "0" ]]; then
  echo "FAIL: lifecycle operations did not converge to applied PostgreSQL state." >&2
  exit 1
fi

echo "PASS: organization, team, and workbook creation activated product metadata and OpenFGA tuples."
echo "PASS: team sharing granted inherited access and organization removal revoked the team path."
echo "PASS: direct external sharing granted and then revoked workbook access."
echo "PASS: all outbox intents were applied and anonymous mutation was rejected."
