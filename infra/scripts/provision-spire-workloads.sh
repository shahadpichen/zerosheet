#!/usr/bin/env bash

# Bootstrap the local SPIRE agent and register the ZeroSheet API and worker.
#
# The generated join token exists only in this process and the first agent
# container. After attestation, the container is recreated without it. The
# public server bundle is written under an ignored directory so the agent can
# verify the server before sending node-attestation evidence.

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
compose_file="${repository_root}/infra/compose.yaml"
environment_file="${repository_root}/.env"
generated_directory="${repository_root}/infra/spire/generated"
server_socket="/run/spire/server/private/api.sock"
agent_socket="/run/spire/agent/public/api.sock"
trust_domain="zerosheet.internal"
agent_id="spiffe://${trust_domain}/agent/racknerd-lab"

if [[ ! -f "${environment_file}" ]]; then
  echo "Missing ${environment_file}. Copy .env.example to .env first." >&2
  exit 1
fi

compose() {
  docker compose \
    --env-file "${environment_file}" \
    --file "${compose_file}" \
    --profile workload-identity-lab \
    "$@"
}

wait_for_server() {
  for _attempt in {1..30}; do
    if compose exec --no-TTY spire-server \
      /opt/spire/bin/spire-server healthcheck \
      -socketPath "${server_socket}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "SPIRE server did not become healthy within 30 seconds." >&2
  return 1
}

wait_for_agent() {
  for _attempt in {1..30}; do
    if compose exec --no-TTY spire-agent \
      /opt/spire/bin/spire-agent healthcheck \
      -socketPath "${agent_socket}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "SPIRE agent did not become healthy within 30 seconds." >&2
  return 1
}

agent_is_healthy() {
  compose exec --no-TTY spire-agent \
    /opt/spire/bin/spire-agent healthcheck \
    -socketPath "${agent_socket}" >/dev/null 2>&1
}

extract_join_token() {
  node --input-type=module --eval '
    const document = JSON.parse(process.argv[1]);
    // SPIRE intentionally names this opaque secret `value`. Validate the UUID
    // shape so a future CLI response change fails before starting the agent.
    if (typeof document.value !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(document.value)) {
      throw new Error("SPIRE token response contained no valid token value");
    }
    process.stdout.write(document.value);
  ' "$1"
}

replace_workload_entry() {
  local entry_id="$1"
  local workload_id="$2"
  local selector="$3"

  # Deleting by deterministic entry ID makes repeated provisioning converge.
  # A missing prior entry is the expected first-run state.
  compose exec --no-TTY spire-server \
    /opt/spire/bin/spire-server entry delete \
    -socketPath "${server_socket}" \
    -entryID "${entry_id}" >/dev/null 2>&1 || true

  compose exec --no-TTY spire-server \
    /opt/spire/bin/spire-server entry create \
    -socketPath "${server_socket}" \
    -entryID "${entry_id}" \
    -parentID "${agent_id}" \
    -spiffeID "${workload_id}" \
    -selector "${selector}" \
    -x509SVIDTTL 300 \
    -jwtSVIDTTL 300 >/dev/null
}

install -d -m 700 "${generated_directory}"
compose up --detach spire-server
wait_for_server

# The bundle is public verification material, not a private signing key. An
# atomic temporary file prevents the agent from reading a partial PEM write.
bundle_temporary="${generated_directory}/bundle.pem.tmp"
compose exec --no-TTY spire-server \
  /opt/spire/bin/spire-server bundle show \
  -socketPath "${server_socket}" \
  -format pem >"${bundle_temporary}"
chmod 644 "${bundle_temporary}"
mv "${bundle_temporary}" "${generated_directory}/bundle.pem"

# An already-attested container can restart from its persistent disk key and
# current agent SVID. Skipping token creation on repeat runs avoids accumulating
# unused bootstrap registrations in the SPIRE datastore.
if [[ -n "$(compose ps --all --quiet spire-agent)" ]]; then
  SPIRE_AGENT_JOIN_TOKEN="" compose up --detach spire-agent
fi

if ! agent_is_healthy; then
  token_document="$(compose exec --no-TTY spire-server \
    /opt/spire/bin/spire-server token generate \
    -socketPath "${server_socket}" \
    -spiffeID "${agent_id}" \
    -ttl 600 \
    -output json)"
  join_token="$(extract_join_token "${token_document}")"

  # Compose passes the token only to this first container incarnation. The
  # agent persists its attested key material in a named volume.
  SPIRE_AGENT_JOIN_TOKEN="${join_token}" compose up --detach --force-recreate spire-agent
  wait_for_agent

  # Remove the already-consumed token from container metadata. The recreated
  # agent proves it can continue using its short-lived agent SVID and disk key.
  SPIRE_AGENT_JOIN_TOKEN="" compose up --detach --force-recreate spire-agent
  wait_for_agent
  unset join_token token_document
fi

replace_workload_entry \
  zerosheet-api-workload \
  "spiffe://${trust_domain}/workload/api" \
  docker:label:org.zerosheet.workload:api
replace_workload_entry \
  zerosheet-worker-workload \
  "spiffe://${trust_domain}/workload/worker" \
  docker:label:org.zerosheet.workload:worker

echo "SPIRE agent attested as ${agent_id}."
echo "Registered spiffe://${trust_domain}/workload/api."
echo "Registered spiffe://${trust_domain}/workload/worker."
