# ZeroSheet

ZeroSheet is an end-to-end encrypted spreadsheet product and a hands-on enterprise IAM learning project.

The product will combine:

- Keycloak for authentication, federation, and enterprise SSO.
- OpenFGA for relationship-based authorization.
- OPA for contextual authorization policies.
- SPIRE for short-lived SPIFFE workload identities.
- PostgreSQL for product, identity-service, and authorization-service state.
- Google Drive and Sheets for encrypted workbook storage and synchronization.

## Current milestone

Milestone 9 uses the API and worker's rotating SPIFFE X.509-SVIDs for a real
TLS 1.3 connection. Both sides validate SPIRE's trust chain and the exact peer
SPIFFE ID; another valid identity from the same trust domain is denied.

## Repository layout

```text
apps/
  api/       HTTP API and policy enforcement point
  web/       Browser application
  worker/    Lifecycle, audit, and background jobs
packages/
  contracts/          Shared runtime-validated API contracts
  workload-identity/  SPIFFE Workload API and exact peer checks
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
pnpm infra:contextual-authorization:verify
pnpm infra:lifecycle:verify
pnpm infra:workload-identity:provision
pnpm infra:workload-identity:verify
pnpm infra:workload-mtls:verify
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

OPA, PDP/PEP/PIP/PAP responsibilities, status-based denial, and decision
composition are explained in
[`docs/learning/06-opa-contextual-authorization.md`](docs/learning/06-opa-contextual-authorization.md).

SCIM provisioning, tenant-scoped joiner/mover/leaver behavior, session
revocation, strict identity linking, and audit evidence are explained in
[`docs/learning/07-enterprise-lifecycle-scim-audit.md`](docs/learning/07-enterprise-lifecycle-scim-audit.md).

SPIFFE IDs, trust domains, SVIDs, the Workload API, SPIRE server/agent roles,
node bootstrap, and Docker workload attestation are explained in
[`docs/learning/08-spiffe-spire-workload-identity.md`](docs/learning/08-spiffe-spire-workload-identity.md).

Mutual TLS, exact peer authorization, streamed SVID rotation, and the private
API-to-worker boundary are explained in
[`docs/learning/09-workload-mtls-zero-trust.md`](docs/learning/09-workload-mtls-zero-trust.md).
