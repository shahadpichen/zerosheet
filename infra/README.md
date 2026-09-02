# Infrastructure

Infrastructure is introduced incrementally so each IAM service can be studied independently. The comments in `compose.yaml` are intentionally detailed because container networking, secrets, persistence, and health checks form part of the IAM trust model.

## Available profiles

- `auth-lab`: PostgreSQL and Keycloak.
- `authorization-lab`: PostgreSQL and OpenFGA's migration/server services.

PostgreSQL has no profile so Docker Compose can treat it as the shared datastore dependency. Selecting `auth-lab` adds Keycloak and waits for PostgreSQL health before starting it.

## Planned profiles

- `governance-lab`: PostgreSQL, OpenFGA, OPA, API, and worker.
- `integrated-test`: the complete IAM stack for temporary end-to-end tests.

## Secret boundary

`.env.example` is documentation containing only local placeholders. The ignored `.env` supplies local values to Compose. RackNerd production will use root-owned mounted secret files instead; development-mode passwords must never be reused.

## Persistence boundary

The named `postgres_data` volume survives `docker compose down`. It is not a backup. A future milestone adds encrypted off-site dumps and a restore drill before public beta.

## ZeroSheet schema migrations

`pnpm infra:db:migrate` applies SQL files from `postgres/migrations` as the restricted `zerosheet_app` role. Using the runtime owner proves an application migration cannot silently modify Keycloak or OpenFGA state.

Migration 002 adds organization, team, workbook, membership, share, and
relationship-outbox tables. The outbox is ZeroSheet product state; OpenFGA
continues to own and evaluate the applied relationship graph in its isolated
database.

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
