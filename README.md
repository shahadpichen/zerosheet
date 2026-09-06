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

Milestone 14 adds a bounded TypeScript record SDK, five-minute quickstart,
encrypted CRM and backend examples, database/provider sharing-drift visibility,
plain-Node deploy smoke tests, and a hardened single-node alpha stack for the
initial VPS. It includes mounted secrets, same-origin Caddy TLS, isolated
service databases, encrypted backup/restore tooling, resource limits, and one
executable release checklist—without claiming the 2 GB topology is highly
available production.

## Repository layout

```text
apps/
  api/       HTTP API and policy enforcement point
  web/       Browser editor and secure Google/share coordinator
  worker/    Lifecycle, audit, and background jobs
packages/
  contracts/          Shared runtime-validated API contracts
  crypto/             Browser recovery, HPKE, workbook keys, and encrypted cells
  google-storage/     Fixed-origin browser Drive and Sheets adapter
  sheet-core/         Selective protection, cell codec, and safe sync sessions
  sdk/                Bounded encrypted record collections over Google tabs
  workload-identity/  SPIFFE Workload API and exact peer checks
docs/
  architecture/       System boundaries and decisions
  learning/           Milestone notes and glossary
  security/           Threat model and residual risks
  specifications/     Persistent format contracts and test vectors
infra/                Local and production infrastructure
examples/             Encrypted CRM UI and typed backend integration
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
pnpm crypto:benchmark:cells
pnpm infra:google-storage:verify
pnpm sheet:benchmark:sync
pnpm infra:sharing:verify
pnpm infra:release:verify
pnpm typecheck
pnpm test
pnpm dev
```

The API listens on `http://localhost:3001` and the web application on `http://localhost:5173` by default.

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

The phrase/private-key boundary, HPKE recipient envelopes, workbook key
hierarchy, authenticated per-cell format, benchmark, and important residual
risks are explained in
[`docs/learning/10-browser-cryptography-recovery.md`](docs/learning/10-browser-cryptography-recovery.md).

The separate Google storage consent flow, narrow scopes, encrypted refresh-token
boundary, direct browser adapter, appData backup, and manual Cloud setup are
explained in
[`docs/learning/11-google-delegated-storage.md`](docs/learning/11-google-delegated-storage.md).

The Univer editor boundary, drag/column protection, 10,000-cell codec,
immutable autosave queue, and Google conflict limitations are explained in
[`docs/learning/12-encrypted-spreadsheet-editor.md`](docs/learning/12-encrypted-spreadsheet-editor.md).

The user HPKE directory, safe first write, three-part sharing transaction,
failure rollback, and resumable key rotation are explained in
[`docs/learning/13-secure-workbook-sharing.md`](docs/learning/13-secure-workbook-sharing.md).

The SDK record model, quickstart/examples, drift visibility, production image
boundary, RackNerd-style single-node bootstrap, mounted secrets, and encrypted
backup/restore drill are explained in
[`docs/learning/14-developer-sdk-production-release.md`](docs/learning/14-developer-sdk-production-release.md).

The persistent cell contract and security analysis live in
[`docs/specifications/encrypted-cell-v1.md`](docs/specifications/encrypted-cell-v1.md)
and [`docs/security/threat-model.md`](docs/security/threat-model.md).
