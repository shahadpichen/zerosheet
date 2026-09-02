#!/usr/bin/env bash

# Verify that Docker workload attributes, rather than shared secrets or image
# possession, determine which short-lived SPIFFE X.509 identity is returned.

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
compose_file="${repository_root}/infra/compose.yaml"
environment_file="${repository_root}/.env"
trust_domain="zerosheet.internal"

if [[ ! -f "${environment_file}" ]]; then
  echo "Missing ${environment_file}. Run pnpm infra:workload-identity:provision first." >&2
  exit 1
fi

compose() {
  docker compose \
    --env-file "${environment_file}" \
    --file "${compose_file}" \
    --profile workload-identity-lab \
    --profile workload-identity-probes \
    "$@"
}

fetch_probe() {
  local service="$1"

  compose run --rm --no-deps --quiet-pull "${service}" 2>/dev/null
}

assert_only_identity() {
  local document="$1"
  local expected="$2"
  local forbidden="$3"

  # The response contains the workload private key. Feed it over stdin rather
  # than a command-line argument so it cannot appear in process listings.
  printf '%s' "${document}" | node --input-type=module --eval '
    import fs from "node:fs";
    import { X509Certificate } from "node:crypto";
    const document = JSON.parse(fs.readFileSync(0, "utf8"));
    const expected = process.argv[1];
    const forbidden = process.argv[2];
    const identities = [];
    function visit(value) {
      if (typeof value === "string" && value.startsWith("spiffe://")) identities.push(value);
      else if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") Object.values(value).forEach(visit);
    }
    visit(document);
    if (!identities.includes(expected)) {
      throw new Error(`Expected ${expected}; received ${identities.join(", ") || "no identity"}`);
    }
    if (identities.includes(forbidden)) {
      throw new Error(`Probe also received forbidden identity ${forbidden}`);
    }
    if (document.svids?.length !== 1 ||
        typeof document.svids[0].x509_svid !== "string" ||
        typeof document.svids[0].x509_svid_key !== "string" ||
        typeof document.svids[0].bundle !== "string") {
      throw new Error("Probe did not receive exactly one complete X.509-SVID");
    }
    const certificate = new X509Certificate(
      Buffer.from(document.svids[0].x509_svid, "base64"),
    );
    const lifetime = Date.parse(certificate.validTo) - Date.parse(certificate.validFrom);
    if (!certificate.subjectAltName?.includes(`URI:${expected}`) ||
        certificate.publicKey.asymmetricKeyType !== "ec" ||
        lifetime < 240_000 || lifetime > 360_000) {
      throw new Error("X.509-SVID SAN, key type, or five-minute lifetime is invalid");
    }
  ' "${expected}" "${forbidden}"
}

api_id="spiffe://${trust_domain}/workload/api"
worker_id="spiffe://${trust_domain}/workload/worker"
api_document="$(fetch_probe spiffe-api-probe)"
worker_document="$(fetch_probe spiffe-worker-probe)"

assert_only_identity "${api_document}" "${api_id}" "${worker_id}"
assert_only_identity "${worker_document}" "${worker_id}" "${api_id}"

# The third container has the same executable and the same socket but no
# registered selector. Returning any SVID would prove image/socket possession
# can bypass workload registration, so success is the failure condition here.
if unregistered_document="$(fetch_probe spiffe-unregistered-probe)"; then
  echo "FAIL: unregistered workload unexpectedly received an SVID: ${unregistered_document}" >&2
  exit 1
fi

entries="$(compose exec --no-TTY spire-server \
  /opt/spire/bin/spire-server entry show \
  -socketPath /run/spire/server/private/api.sock \
  -output json)"
printf '%s' "${entries}" | node --input-type=module --eval '
  import fs from "node:fs";
  const document = JSON.parse(fs.readFileSync(0, "utf8"));
  const expected = [
    {
      id: "zerosheet-api-workload",
      path: "/workload/api",
      selector: "label:org.zerosheet.workload:api",
    },
    {
      id: "zerosheet-worker-workload",
      path: "/workload/worker",
      selector: "label:org.zerosheet.workload:worker",
    },
  ];
  for (const item of expected) {
    const entry = document.entries?.find((candidate) => candidate.id === item.id);
    if (!entry ||
        entry.spiffe_id?.trust_domain !== "zerosheet.internal" ||
        entry.spiffe_id?.path !== item.path ||
        entry.x509_svid_ttl !== 300 ||
        !entry.selectors?.some((selector) =>
          selector.type === "docker" && selector.value === item.selector)) {
      throw new Error(`Registration ${item.id} is missing or malformed`);
    }
  }
'

echo "PASS: the API label received only ${api_id}."
echo "PASS: the worker label received only ${worker_id}."
echo "PASS: the same image with an unregistered label received no identity."
echo "PASS: both EC X.509-SVIDs contain the expected URI SAN and five-minute lifetime."
echo "PASS: both registrations use explicit Docker selectors and five-minute TTLs."
