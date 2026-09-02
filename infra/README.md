# Infrastructure

Infrastructure is introduced incrementally so each IAM service can be studied independently. The comments in `compose.yaml` are intentionally detailed because container networking, secrets, persistence, and health checks form part of the IAM trust model.

## Available profiles

- `auth-lab`: PostgreSQL and Keycloak.
- `authorization-lab`: PostgreSQL and OpenFGA's migration/server services.
- `contextual-authorization-lab`: stateless OPA with read-only ZeroSheet Rego
  policy.
- `workload-identity-lab`: SPIRE server and one node agent with a local
  Workload API socket.
- `workload-identity-probes`: one-shot positive and negative attestation
  clients used only by the verifier.
- `workload-mtls-lab`: the private Node API listener that consumes a rotating
  API X.509-SVID and requires client certificates.
- `workload-mtls-probes`: registered and negative Node clients that verify
  exact peer authorization, mandatory client identity, and TLS-only transport.

PostgreSQL has no profile so Docker Compose can treat it as the shared datastore dependency. Selecting `auth-lab` adds Keycloak and waits for PostgreSQL health before starting it.

## Planned profiles

- `governance-lab`: PostgreSQL, both PDPs, API, and worker.
- `integrated-test`: the complete IAM stack for temporary end-to-end tests.

## Secret boundary

`.env.example` is documentation containing only local placeholders. The ignored `.env` supplies local values to Compose. RackNerd production will use root-owned mounted secret files instead; development-mode passwords must never be reused.

## Persistence boundary

The named `postgres_data` volume survives `docker compose down`. SPIRE server,
agent, and socket state use separate named volumes with different trust and
lifecycle requirements. None of these volumes is a backup. A future milestone
adds encrypted off-site dumps and a restore drill before public beta.

## ZeroSheet schema migrations

`pnpm infra:db:migrate` applies SQL files from `postgres/migrations` as the restricted `zerosheet_app` role. Using the runtime owner proves an application migration cannot silently modify Keycloak or OpenFGA state.

Migration 002 adds organization, team, workbook, membership, share, and
relationship-outbox tables. The outbox is ZeroSheet product state; OpenFGA
continues to own and evaluate the applied relationship graph in its isolated
database.

Migration 004 adds tenant-bound SCIM connections, managed users,
organization-user lifecycle facts, and append-only security audit events. The
API stores only SCIM credential digests; plaintext credentials exist only in
the administrator's creation response.

Migration 005 adds delegated Google storage OAuth transactions and connections.
Transactions are expiring and one-use; connections store only an AES-256-GCM
refresh-token envelope and exact granted scopes. The independent encryption key
stays outside PostgreSQL, and verification never selects credential envelopes.

Milestone 3 keeps the API on the developer host and adds Google as a Keycloak-
brokered upstream identity provider. `pnpm infra:federation:google:configure`
creates or updates that provider for an existing realm, while
`pnpm infra:federation:google:verify` applies it and checks Keycloak's persisted
security settings.

Google federation is disabled while `.env` contains placeholders. After real
development credentials are added, set `GOOGLE_IDENTITY_PROVIDER_ENABLED=true`
and rerun the verifier. With `pnpm dev` running, `pnpm infra:oidc:verify` also
checks the live API-to-Keycloak redirect and the fixed Google broker hint.

Milestone 4 starts both current profiles with `pnpm infra:authorization:up`.
OpenFGA owns only the `openfga` database. The one-shot migration container must
complete before the decision server starts, and its public host binding is
loopback-only. `pnpm infra:authorization:model:test` validates policy without a
server; `pnpm infra:authorization:provision` writes the tested model; and
`pnpm infra:authorization:verify` checks the live API PEP.

Milestone 5 keeps those services and adds `pnpm infra:product:verify`. The live
check performs product creation and revocation through the API, then proves the
corresponding metadata and relationship intents converged.

Milestone 6 makes `pnpm infra:authorization:up` start OPA alongside the existing
services. `pnpm infra:contextual-authorization:policy:test` runs Rego tests in
the pinned engine. After migration 003 and the API are running,
`pnpm infra:contextual-authorization:verify` proves account/tenant suspension
overrides an unchanged OpenFGA allow and that reactivation restores access.

Milestone 7 adds `pnpm infra:lifecycle:verify`. With the API running, it creates
a temporary tenant and SCIM connection, provisions/deactivates/reactivates a
managed user, proves session and relationship revocation, verifies OPA denial
over an unchanged direct share, exports authorized audit events, and confirms
the database rejects an audit UPDATE. Temporary product state is cleaned up;
append-only verifier audit evidence remains by design and contains random IDs.

Milestone 8 adds `pnpm infra:workload-identity:provision` and
`pnpm infra:workload-identity:verify`. Provisioning starts the pinned official
SPIRE 1.15.2 server and agent, performs one-time node attestation, removes the
consumed bootstrap token from container metadata, and registers separate API
and worker Docker selectors. The verifier fetches both five-minute EC
X.509-SVIDs, validates their URI SANs, and proves an unregistered container with
the same image and Workload API socket receives no identity.

Milestone 9 adds `pnpm infra:workload-mtls:verify`. It builds the pinned Node
24 workload image, starts an unprivileged private API listener, and proves a
worker SVID receives HTTP 200 while a chain-valid API SVID is denied with HTTP 403. Additional controls reject the wrong server SPIFFE ID, a client without an
SVID, plaintext HTTP, and any host port mapping. Private key material remains
in process memory and is scanned out of all captured verification output.

Milestone 11 adds `pnpm infra:google-storage:verify`. It verifies the browser
Drive/Sheets adapter, server OAuth service and route boundary, refresh-token
protection, and live migration 005 schema without requiring a Google account or
printing credentials. Real Google consent uses the separate storage OAuth client
described in `docs/learning/11-google-delegated-storage.md`.

The Docker agent's host PID namespace and Docker daemon socket are a deliberate
learning-lab tradeoff. Production should prefer a platform-native node agent
and attestors. SPIRE management and Workload API sockets are never published as
host TCP ports.

The mTLS API's TCP 3443 declaration is internal-only and has no host mapping.
Production will place equivalent workload listeners on an explicitly isolated
network and retain exact ID allowlists; private network placement alone is not
authentication.
