# Infrastructure

Infrastructure is introduced incrementally so each IAM service can be studied independently. The comments in `compose.yaml` are intentionally detailed because container networking, secrets, persistence, and health checks form part of the IAM trust model.

## Available profile

- `auth-lab`: PostgreSQL and Keycloak.

PostgreSQL has no profile so Docker Compose can treat it as the shared datastore dependency. Selecting `auth-lab` adds Keycloak and waits for PostgreSQL health before starting it.

## Planned profiles

- `authorization-lab`: PostgreSQL, OpenFGA, OPA, API, and Caddy.
- `governance-lab`: PostgreSQL, OpenFGA, OPA, API, and worker.
- `integrated-test`: the complete IAM stack for temporary end-to-end tests.

## Secret boundary

`.env.example` is documentation containing only local placeholders. The ignored `.env` supplies local values to Compose. RackNerd production will use root-owned mounted secret files instead; development-mode passwords must never be reused.

## Persistence boundary

The named `postgres_data` volume survives `docker compose down`. It is not a backup. A future milestone adds encrypted off-site dumps and a restore drill before public beta.

## ZeroSheet schema migrations

`pnpm infra:db:migrate` applies SQL files from `postgres/migrations` as the restricted `zerosheet_app` role. Using the runtime owner proves an application migration cannot silently modify Keycloak or OpenFGA state.

Milestone 3 keeps the API on the developer host and adds Google as a Keycloak-
brokered upstream identity provider. `pnpm infra:federation:google:configure`
creates or updates that provider for an existing realm, while
`pnpm infra:federation:google:verify` applies it and checks Keycloak's persisted
security settings.

Google federation is disabled while `.env` contains placeholders. After real
development credentials are added, set `GOOGLE_IDENTITY_PROVIDER_ENABLED=true`
and rerun the verifier. With `pnpm dev` running, `pnpm infra:oidc:verify` also
checks the live API-to-Keycloak redirect and the fixed Google broker hint.
