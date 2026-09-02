# ZeroSheet

ZeroSheet is an end-to-end encrypted spreadsheet product and a hands-on enterprise IAM learning project.

The product will combine:

- Keycloak for authentication, federation, and enterprise SSO.
- OpenFGA for relationship-based authorization.
- OPA for contextual authorization policies.
- PostgreSQL for product, identity-service, and authorization-service state.
- Google Drive and Sheets for encrypted workbook storage and synchronization.

## Current milestone

Milestone 2 connects the ZeroSheet API/BFF to Keycloak through the OIDC Authorization Code flow with PKCE. The browser receives only an opaque HttpOnly product-session cookie; it never receives Keycloak tokens.

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
pnpm infra:db:migrate
pnpm typecheck
pnpm test
pnpm dev
```

The API listens on `http://127.0.0.1:3001` and the web application on `http://127.0.0.1:5173` by default.

With the API and web app running, `pnpm infra:oidc:verify` checks the live
PostgreSQL, Keycloak, PKCE, cookie, and redirect boundaries without printing
credential values.
