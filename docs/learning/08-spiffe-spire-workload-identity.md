# Milestone 8: SPIFFE and SPIRE workload identity

## Learning objective

Understand how a running service proves what workload it is without using a
human login, a copied API key, or a long-lived certificate stored in an
environment variable. Learn the roles of a SPIFFE ID, trust domain, SVID,
Workload API, node attestation, workload attestation, SPIRE server, and SPIRE
agent before using those identities for mutual TLS in Milestone 9.

The official specifications and implementation references used here are:

- [SPIFFE concepts](https://spiffe.io/docs/latest/spiffe/concepts/)
- [SPIFFE ID and SVID specification](https://spiffe.io/docs/latest/spiffe-specs/spiffe-id/)
- [SPIFFE Workload API](https://spiffe.io/docs/latest/spiffe-specs/spiffe_workload_api/)
- [SPIRE workload registration](https://spiffe.io/docs/latest/deploying/registering/)
- [SPIRE Docker workload attestor](https://github.com/spiffe/spire/blob/main/doc/plugin_agent_workloadattestor_docker.md)

## Human identity versus workload identity

Keycloak and OIDC establish a human browser principal:

```text
human -> Google or local account -> Keycloak -> ZeroSheet session
```

SPIFFE and SPIRE establish a running software principal:

```text
container process -> local SPIRE agent -> attested attributes
                  -> short-lived SVID for a registered SPIFFE ID
```

These are different identity planes. The API workload having a valid SVID does
not sign a user in, grant a workbook relationship, or possess a workbook key.
Likewise, an administrator's browser session is not evidence that a network
caller is the real worker service.

## The core terms

| Term         | Meaning in ZeroSheet                                                                                                       |
| ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Workload     | One deployed software role, such as the API or background worker. Replicas of the same role may share a workload identity. |
| Trust domain | The cryptographic and administrative identity boundary. The lab uses `zerosheet.internal`.                                 |
| SPIFFE ID    | A URI name inside that domain, such as `spiffe://zerosheet.internal/workload/api`. It is a name, not a secret.             |
| SVID         | A cryptographically verifiable identity document containing a SPIFFE ID. This lab uses X.509-SVID certificates.            |
| Trust bundle | The current public CA material used to validate SVIDs from a trust domain.                                                 |
| Workload API | A local gRPC API over a Unix socket that streams SVIDs, private keys, and bundles to an attested process.                  |
| SPIRE server | The control plane that stores registration policy and signs short-lived SVIDs.                                             |
| SPIRE agent  | The per-node data plane that attests local callers and exposes the Workload API.                                           |
| Selector     | An attested attribute matched by registration policy. The Docker lab uses an explicit container label.                     |

`spiffe://zerosheet.internal/workload/api` is comparable to a service username,
but its current X.509-SVID is the short-lived proof that the caller owns that
identity. Checking only the URI string would be like trusting an unverified
`userId` sent in JSON.

## Trust-domain design

The lab IDs are:

```text
spiffe://zerosheet.internal/agent/racknerd-lab
spiffe://zerosheet.internal/workload/api
spiffe://zerosheet.internal/workload/worker
```

The trust domain corresponds to one root of workload trust. Production and
staging should not share it: an SVID issued by a less protected development
control plane must never authenticate to production. Separate regions or
companies can use separate trust domains and explicitly exchange public bundles
only when federation is intended.

This federation is not Google identity federation. Keycloak trusting Google
means accepting upstream human authentication through OIDC. SPIFFE federation
means obtaining another workload trust domain's public bundle so a service can
cryptographically validate that domain's SVIDs.

## Node bootstrap and attestation

The SPIRE server must first decide which agent represents the Docker node. The
learning lab uses the built-in join-token node attestor:

1. the server creates a random token with a ten-minute expiry;
2. the agent receives it only for initial attestation;
3. SPIRE consumes it and issues the agent identity;
4. the agent persists its own key in a dedicated volume; and
5. the provisioning script force-recreates the container without the consumed
   token in its environment.

The token solves first contact; it is not a recurring service credential. Join
tokens are convenient for a lab but weak for unattended production bootstrap.
RackNerd deployment should use a stronger node mechanism available to the
actual platform, such as a TPM/X.509 proof or tightly controlled systemd host
provisioning. Kubernetes would normally use a Kubernetes node attestor.

The agent verifies the server against a generated public trust bundle rather
than enabling insecure bootstrap. Signing keys remain only in the SPIRE server
volume.

## Workload attestation

Both probe containers run the same official SPIRE CLI image and can reach the
same Unix socket. They differ only in an explicit label:

```text
org.zerosheet.workload=api
org.zerosheet.workload=worker
org.zerosheet.workload=unregistered
```

The SPIRE agent obtains the caller's container ID from kernel/cgroup metadata,
queries Docker, and produces selectors from the real container labels. The
server registration entries map only these selectors:

```text
docker:label:org.zerosheet.workload:api
  -> spiffe://zerosheet.internal/workload/api

docker:label:org.zerosheet.workload:worker
  -> spiffe://zerosheet.internal/workload/worker
```

The unregistered label receives no identity. Possessing the same executable or
the same socket mount is insufficient.

Labels are suitable for demonstrating the mechanism, not a complete production
supply-chain policy. Anyone who can create arbitrarily labelled containers on
the node can request those identities. Production must restrict deployment
authority and should add stronger selectors such as image digests or signed
image attestations where the platform supports them.

## Why the Workload API is local

The Workload API is mounted as a Unix domain socket and has no bearer password.
That is intentional: the agent identifies the calling process out of band from
local operating-system/container metadata. Publishing this bootstrap endpoint
as an ordinary network API would destroy that assumption.

The probe containers have `network_mode: none`; they need only the local socket.
No SPIRE server or agent port is published to the host or internet. The server
and agent communicate on the private Compose network.

The API response contains an unencrypted PKCS#8 private key because the workload
needs it for TLS. The verifier keeps the response only in process memory and
feeds it to validation over stdin so key bytes do not appear in command-line
arguments or logs. Application code must likewise keep SVID keys in memory and
follow streamed rotations rather than save them to PostgreSQL.

## X.509-SVID properties

Each workload registration requests:

- an EC P-256 key;
- an X.509 certificate whose URI SAN is the exact SPIFFE ID;
- a five-minute SVID lifetime; and
- the trust-domain bundle needed to validate peers.

Short lifetime reduces the usefulness of stolen material and supports rapid
rotation. It does not remove the need to protect memory, the Workload API
socket, deployment authority, or the SPIRE signing keys.

Milestone 8 proves issuance only. Milestone 9 now uses these identities for an
actual TLS client and server, streams rotations, validates the trust bundle,
and authorizes each peer's exact SPIFFE ID. Encryption without peer-ID
authorization would accept any workload in the trust domain.

## Data and process boundaries

SPIRE state is intentionally separate:

- `spire_server_data` contains the lab SQLite registration datastore and
  signing-key file;
- `spire_agent_data` contains the attested agent key and runtime state;
- `spire_server_socket` contains the private management socket;
- `spire_agent_socket` contains the workload-facing socket; and
- `infra/spire/generated/bundle.pem` is ignored, public bootstrap material.

The local server uses SQLite because exactly one SPIRE server runs on this
small learning VPS. A highly available deployment needs the supported
PostgreSQL datastore, multiple servers, protected key management, backups, and
tested CA rotation. The named volumes are persistence, not backups.

## Docker security tradeoff

The Docker workload attestor needs the daemon socket and host PID visibility.
Access to Docker's control socket is security-sensitive even when mounted
read-only, because the socket protocol—not the mount flag—controls operations.
The agent is therefore part of the trusted computing base.

The lab still removes Linux capabilities, uses a read-only root filesystem,
publishes no ports, limits memory, and mounts only dedicated state paths. On a
production Linux VPS, a systemd-managed host agent with Unix/process selectors
can avoid placing the agent itself inside Docker. Kubernetes uses an agent
DaemonSet plus platform-native attestation and socket delivery.

## Commands and verification

```bash
pnpm infra:workload-identity:config
pnpm infra:workload-identity:provision
pnpm infra:workload-identity:verify
pnpm infra:workload-identity:logs
pnpm infra:workload-identity:down
```

Provisioning is idempotent. It reuses a healthy attested agent, replaces the two
deterministic workload registrations, and does not generate another join token
on normal repeat runs.

The live verifier proves:

1. the API-labelled process receives only the API SPIFFE ID;
2. the worker-labelled process receives only the worker SPIFFE ID;
3. an unregistered process using the same image and socket receives no SVID;
4. each certificate contains the exact URI SAN and an EC public key;
5. each certificate lifetime is approximately five minutes; and
6. server registrations contain the expected Docker selectors and TTLs.

## Security invariants

1. Human OIDC identity and workload SPIFFE identity are separate.
2. A SPIFFE ID is a name; only a bundle-validated SVID proves it.
3. The Workload API remains local and is never exposed as a public service.
4. Workloads receive no static SPIFFE password or committed private key.
5. API and worker have different registrations and cannot fetch each other's
   SVID merely by sharing an image or socket.
6. An unmatched workload receives no default identity.
7. SVID private keys stay in memory and never enter logs, arguments, or product
   databases.
8. Join-token bootstrap is short-lived and removed from container metadata
   after it is consumed.
9. Development and production use different trust domains and roots.
10. mTLS must validate and authorize the exact peer SPIFFE ID, not just any
    certificate signed by the trust domain.

## Deliberately deferred

- Applying the Milestone 9 API-to-worker mTLS boundary to the real outbox job.
- Replacing OpenFGA's local pre-shared key with workload-authenticated traffic.
- Production node attestation, image-signature selectors, and deployment policy.
- HA SPIRE servers with PostgreSQL and externally protected signing keys.
- CA/bundle rotation, disaster recovery, and trust-domain federation drills.
- Mapping workload identities into OPA policy and security audit actors.
