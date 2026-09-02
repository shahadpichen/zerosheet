#!/usr/bin/env bash

# Exercise the real Node API and worker over SPIFFE-authenticated mutual TLS.
# Positive and negative controls prove chain validation, exact workload-ID
# authorization, mandatory client certificates, and encryption-only transport.

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
compose_file="${repository_root}/infra/compose.yaml"
environment_file="${repository_root}/.env"

if [[ ! -f "${environment_file}" ]]; then
  echo "Missing ${environment_file}. Copy .env.example to .env first." >&2
  exit 1
fi

compose() {
  docker compose \
    --env-file "${environment_file}" \
    --file "${compose_file}" \
    --profile workload-identity-lab \
    --profile workload-mtls-lab \
    --profile workload-mtls-probes \
    "$@"
}

run_probe() {
  local service="$1"

  # Compose diagnostics go to stderr and would make the JSON assertion
  # ambiguous. The application emits its single deliberately safe result to
  # stdout; failure still propagates through the command's exit status.
  compose run --rm --no-deps --quiet-pull "${service}" 2>/dev/null
}

assert_probe_result() {
  local document="$1"
  local expected_caller="$2"
  local expected_status="$3"

  printf '%s' "${document}" | node --input-type=module --eval '
    import fs from "node:fs";
    const result = JSON.parse(fs.readFileSync(0, "utf8"));
    const expectedCaller = process.argv[1];
    const expectedStatus = Number.parseInt(process.argv[2], 10);
    if (result.event !== "internal_mtls_probe_passed" ||
        result.caller !== expectedCaller ||
        result.expectedServer !== "spiffe://zerosheet.internal/workload/api" ||
        result.statusCode !== expectedStatus) {
      throw new Error("mTLS probe returned an unexpected safe result document");
    }
  ' "${expected_caller}" "${expected_status}"
}

# Provisioning is idempotent and confirms the agent has the two selector-bound
# registrations before application containers ask for credentials.
bash "${repository_root}/infra/scripts/provision-spire-workloads.sh"
compose build mtls-api
compose up --detach --wait mtls-api

worker_id="spiffe://zerosheet.internal/workload/worker"
api_id="spiffe://zerosheet.internal/workload/api"

worker_result="$(run_probe mtls-worker-probe)"
assert_probe_result "${worker_result}" "${worker_id}" 200

# The API SVID chains to the same trust root, so reaching HTTP 403 proves the
# denial comes from exact peer authorization after successful mutual TLS.
api_caller_result="$(run_probe mtls-api-caller-probe)"
assert_probe_result "${api_caller_result}" "${api_id}" 403

# This client has a legitimate worker SVID but intentionally pins the wrong
# server identity. Success would mean the client trusts any bundle member.
if wrong_server_result="$(compose run --rm --no-deps --quiet-pull mtls-wrong-server-id-probe 2>&1)"; then
  echo "FAIL: worker accepted an unexpected server SPIFFE ID." >&2
  exit 1
fi

no_client_result="$(run_probe mtls-no-client-certificate-probe)"
plaintext_result="$(run_probe mtls-plaintext-probe)"

printf '%s' "${no_client_result}" | node --input-type=module --eval '
  import fs from "node:fs";
  const result = JSON.parse(fs.readFileSync(0, "utf8"));
  if (result.event !== "missing_client_certificate_rejected") {
    throw new Error("missing-client-certificate control did not pass");
  }
'

printf '%s' "${plaintext_result}" | node --input-type=module --eval '
  import fs from "node:fs";
  const result = JSON.parse(fs.readFileSync(0, "utf8"));
  if (result.event !== "plaintext_internal_http_rejected") {
    throw new Error("plaintext control did not pass");
  }
'

# A private Docker `expose` declaration is documentation only; it must not turn
# into a host port mapping. Inspecting container metadata avoids version-specific
# `docker compose port` output for ports that intentionally have no binding.
mtls_api_container_id="$(compose ps --quiet mtls-api)"
port_bindings="$(docker inspect --format '{{json .HostConfig.PortBindings}}' "${mtls_api_container_id}")"
printf '%s' "${port_bindings}" | node --input-type=module --eval '
  import fs from "node:fs";
  const bindings = JSON.parse(fs.readFileSync(0, "utf8"));
  if (bindings !== null && Object.keys(bindings).length !== 0) {
    throw new Error("internal mTLS container has a host port binding");
  }
'

# Scan every deliberately captured output plus the server log for markers that
# would indicate raw Workload API/private-key material escaped into logs.
server_logs="$(compose logs --no-color mtls-api 2>&1)"
combined_safe_output="${worker_result}${api_caller_result}${wrong_server_result}${no_client_result}${plaintext_result}${server_logs}"
if printf '%s' "${combined_safe_output}" | grep -Eiq -- 'BEGIN (EC |RSA )?PRIVATE KEY|x509[_-]svid[_-]key'; then
  echo "FAIL: mTLS verification output contains private-key material." >&2
  exit 1
fi

echo "PASS: the worker SVID completed a TLS 1.3 request and received HTTP 200."
echo "PASS: the API SVID was chain-valid but denied by exact caller authorization with HTTP 403."
echo "PASS: the worker rejected a bundle-valid server whose exact SPIFFE ID was not allowlisted."
echo "PASS: a client with only the public trust bundle could not complete mutual TLS."
echo "PASS: the internal port rejected plaintext HTTP and has no host port mapping."
echo "PASS: captured process output and server logs contain no private-key markers."
