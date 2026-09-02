# ZeroSheet

ZeroSheet is an end-to-end encrypted spreadsheet product and a hands-on enterprise IAM learning project.

The product will combine:

- Keycloak for authentication, federation, and enterprise SSO.
- OpenFGA for relationship-based authorization.
- OPA for contextual authorization policies.
- PostgreSQL for product, identity-service, and authorization-service state.
- Google Drive and Sheets for encrypted workbook storage and synchronization.

## Current milestone

Milestone 5 adds the first product control plane. Authenticated users can create
organizations, teams, and workbook metadata, while membership and sharing APIs
coordinate PostgreSQL state with retryable OpenFGA relationship mutations.

## Repository layout

```text
apps/
  api/       HTTP API and policy enforcement point
  web/       Browser application
  worker/    Lifecycle, audit, and background jobs
packages/
  contracts/ Shared runtime-validated API contracts
docs/
  architecture/ System boundaries and decisions
  learning/     Milestone notes and glossary
infra/          Local and production infrastructure
```

## Requirements

- Node.js 24
- pnpm 10
- Docker with Compose (infrastructure milestones)

## Development

```bash
pnpm install
pnpm infra:auth:up
pnpm infra:federation:google:verify
pnpm infra:authorization:up
pnpm infra:authorization:provision
pnpm infra:db:migrate
pnpm infra:product:verify
pnpm typecheck
pnpm test
pnpm dev
```

The API listens on `http://127.0.0.1:3001` and the web application on `http://127.0.0.1:5173` by default.

With the API and web app running, `pnpm infra:oidc:verify` checks the live
PostgreSQL, Keycloak, PKCE, cookie, and redirect boundaries without printing
credential values.

Google federation starts disabled with placeholder credentials. Follow
[`docs/learning/03-google-identity-federation.md`](docs/learning/03-google-identity-federation.md)
to create a development Google OAuth client and enable interactive Google login.

The OpenFGA model and all authorization concepts are explained in
[`docs/learning/04-openfga-authorization-foundation.md`](docs/learning/04-openfga-authorization-foundation.md).

The transactional outbox, product APIs, joiner/mover/leaver rules, and sharing
lifecycle are explained in
[`docs/learning/05-product-authorization-lifecycle.md`](docs/learning/05-product-authorization-lifecycle.md).
