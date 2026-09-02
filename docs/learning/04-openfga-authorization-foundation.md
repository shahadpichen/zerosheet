# Milestone 4: OpenFGA relationship authorization and the first PEP

## Learning objective

Understand the separation between authentication and authorization, model
ZeroSheet relationships using Zanzibar-style ReBAC, and enforce an OpenFGA
decision inside the API without trusting a browser-supplied principal.

## Authentication stops before authorization begins

The previous milestones answer:

```text
Who authenticated?
```

Keycloak verifies the login and ZeroSheet maps the Keycloak `(issuer, subject)`
to a stable product-user UUID. That does not answer:

```text
Can this product user view or edit this particular workbook?
```

Milestone 4 gives that second question to OpenFGA.

```text
Browser request + opaque session
  -> ZeroSheet API resolves product user from PostgreSQL
  -> API asks OpenFGA:
       user:<product-user-uuid>
       can_view
       workbook:<workbook-uuid>
  -> OpenFGA evaluates the pinned model and current relationship tuples
  -> API returns the resource only for allowed=true
```

The browser cannot choose the `user:<id>` value. It supplies only its opaque
HttpOnly session, and the API derives the principal from server-side state.

## Google Zanzibar, ReBAC, and OpenFGA

Google Zanzibar is the architecture and research system that popularized
large-scale relationship-based authorization. It is unrelated to Google OAuth
login. OpenFGA is an open-source Zanzibar-inspired authorization server.

ReBAC stores facts as relationship tuples:

```text
user:alice            owner   workbook:budget
user:bob              member  team:finance
team:finance#member   editor  workbook:budget
```

Each tuple has:

```text
user / userset    relation    object
```

The second and third tuples mean that every current Finance team member is an
editor of the budget workbook. OpenFGA evaluates that graph at request time. If
Bob is removed from Finance, his inherited workbook access disappears without
deleting a separate Bob tuple from every Finance workbook.

## Model versus tuples

The authorization model is application policy:

```text
workbook editor may be a user or team#member
workbook viewer includes editor
can_view is derived from viewer
```

Tuples are live product facts:

```text
Alice owns workbook 123
Bob belongs to Finance
Finance edits workbook 123
```

Models are immutable and versioned in OpenFGA. ZeroSheet pins an explicit model
ID in every running API process. A new model is a security deployment, not an
unreviewed configuration edit.

## The ZeroSheet model

The source of truth is [`infra/openfga/model.fga`](../../infra/openfga/model.fga).
It contains four domain types.

### `user`

The ID is the ZeroSheet product-user UUID. It is not an email address, Google
subject, or Keycloak subject. Authentication providers can change without
rewriting resource relationships.

### `organization`

- `owner` is directly assigned.
- `admin` includes direct admins and owners.
- `member` includes direct members, admins, and owners.
- `can_manage_members` is derived from admin.
- `can_create_workbook` is derived from member.

### `team`

- `organization` locates the team inside one organization.
- `manager` is directly assigned.
- `member` includes direct members and managers.
- `can_manage` includes team managers and organization admins.

Organization administrators can manage a team without automatically becoming
team members. This prevents a team-based workbook share from silently revealing
every workbook to every organization administrator.

### `workbook`

- `organization` records the containing tenant but grants no data access.
- `owner` is a directly assigned user.
- `editor` accepts direct users, team-member usersets, and owners.
- `viewer` accepts direct users, team-member usersets, and editors.
- `can_view`, `can_edit`, and `can_manage_sharing` are the permissions used by
  API routes.

The model allows an explicit external viewer who is not an organization member.
That supports sharing a workbook outside the owner organization without making
all organization membership rules equivalent to workbook visibility.

## Organization administration does not imply plaintext access

ZeroSheet is an end-to-end encrypted product. An organization administrator may
need to invite employees, manage teams, suspend accounts, or configure SSO. None
of those tasks inherently requires reading workbook plaintext.

The model therefore deliberately makes this result possible:

```text
Oscar can_manage_members organization:acme = true
Oscar can_manage team:finance             = true
Oscar can_view workbook:budget            = false
```

If a product later introduces enterprise recovery, that capability must be
explicit, auditable, and reflected in both authorization policy and key-envelope
design. It must not arrive accidentally through the word `admin`.

## PDP, PEP, PIP, and PAP in this milestone

### PDP - Policy Decision Point

OpenFGA is the PDP for durable relationship questions. It receives a principal,
permission, and resource and returns an allow/deny decision.

### PEP - Policy Enforcement Point

The ZeroSheet API route is the PEP. It obtains the trusted principal, asks the
PDP, and withholds the resource unless the response is exactly `allowed=true`.
Calling OpenFGA but ignoring its denial would not be enforcement.

### PIP - Policy Information Point

Current relationship tuples are authorization information. PostgreSQL also
supplies session and product-user facts. Future PIPs can supply organization
status, workbook classification, device posture, or risk information.

### PAP - Policy Administration Point

The reviewed `model.fga` file, its tests, Git history, and provisioning command
form the initial policy-administration workflow. A future administrative UI may
manage tuples, but built-in policy changes remain reviewed code changes.

## Why the API asks permissions rather than roles

Routes ask `can_view` or `can_edit`; they do not fetch `viewer`, `editor`, and
`owner` tuples and reproduce inheritance in TypeScript. This keeps policy in one
versioned model.

For example, `can_view` can later include a new audited relationship without
editing every read endpoint. Conversely, removing an inheritance rule changes
the central decision instead of relying on all services to update correctly.

## Consistency and revocation

The API uses OpenFGA's `HIGHER_CONSISTENCY` preference for protected workbook
checks. This can cost more latency than a cache-oriented preference, but sharing
removal should not continue returning a stale allow.

Consistency preference is only one part of revocation. Key envelopes, cached
plaintext, offline clients, Google Drive permissions, and active sessions also
need explicit revocation behavior in later milestones.

## Authorization is necessary but not sufficient for decryption

An OpenFGA allow means the product relationship permits access. It does not
contain or release a workbook encryption key.

A future read flow requires both:

```text
OpenFGA can_view = true
AND
the authorized client has a valid HPKE-wrapped workbook-key envelope
```

Google Drive sharing will be another synchronized control. An accidental Drive
share must not reveal plaintext without the cryptographic envelope, and a stale
key envelope must not make the API ignore an OpenFGA revocation.

## Local infrastructure

OpenFGA 1.18.1 runs as an independent server and owns the existing isolated
`openfga` PostgreSQL database. It cannot connect to ZeroSheet or Keycloak data.

The Compose flow is:

```text
PostgreSQL becomes healthy
  -> one-shot openfga migrate service applies OpenFGA's schema
  -> OpenFGA starts with pre-shared API authentication
  -> health check proves the gRPC server is ready
```

Only the loopback HTTP decision port is published. The playground is disabled,
and gRPC remains private to the Compose network.

The pre-shared key is a local learning credential. A later workload-identity
milestone replaces static service credentials with authenticated service
identity and mTLS.

## Model testing and provisioning

Run the embedded model tests before starting the service:

```bash
pnpm infra:authorization:model:test
```

The tests currently exercise 36 positive and negative decisions. Negative tests
are essential because a policy that accidentally allows everyone can still pass
every positive-only assertion.

Start and provision the persistent service:

```bash
pnpm infra:authorization:up
pnpm infra:authorization:provision
```

Provisioning performs four steps:

1. The pinned official OpenFGA CLI validates the DSL.
2. The CLI transforms it to the JSON API representation.
3. The provisioner finds or creates one named store.
4. It reuses the latest semantically identical model or writes a new immutable
   version when policy changed.

OpenFGA generates store and model ULIDs. The provisioner writes them to the
ignored, mode-`0600` `.env.openfga` file. They are not secrets, but keeping them
machine-local avoids pretending two independent databases share identifiers.

## API startup and fail-closed behavior

The API loads `.env` followed by `.env.openfga`, constructs one official SDK
client, and confirms that the pinned model is readable before listening.

During requests:

- no product session returns HTTP 401 before an OpenFGA call;
- an explicit OpenFGA denial returns HTTP 403;
- an explicit allow permits the protected response;
- malformed or missing decision data is treated as denial; and
- a decision-service error becomes a server error, never an allow.

The learning PEP endpoint is:

```text
GET /workbooks/:workbookId/access
```

It returns only a proof that `can_view` succeeded. Actual workbook metadata,
ciphertext synchronization, and keys are deliberately deferred.

## Commands

```bash
pnpm infra:authorization:model:test
pnpm infra:authorization:up
pnpm infra:authorization:provision
pnpm infra:db:migrate
pnpm dev
pnpm infra:authorization:verify
```

The live verifier creates temporary users, opaque session digests, and one
owner tuple. It proves 200/403/401 enforcement and removes all temporary state
on exit.

## Security invariants

1. Authentication establishes a principal; it grants no workbook access.
2. The browser cannot choose the principal sent to OpenFGA.
3. OpenFGA uses ZeroSheet product-user UUIDs, not mutable emails.
4. API routes ask stable permissions rather than reimplementing role logic.
5. Only `allowed=true` permits a protected response.
6. Authorization-service failure never permits access.
7. Organization administration does not imply workbook visibility.
8. Model changes are versioned and tested with allow and deny cases.
9. Protected checks pin an immutable model ID and prefer higher consistency.
10. OpenFGA stores relationships, never workbook keys or plaintext.

## Deliberately deferred

- Product APIs for creating organizations, teams, workbooks, and tuples
  (delivered in [Milestone 5](05-product-authorization-lifecycle.md)).
- Invitation, joiner/mover/leaver, and SCIM lifecycle workflows.
- OPA contextual rules for tenant status, device posture, or risk.
- Permission-aware workbook listing with OpenFGA `ListObjects`.
- Audit events for every decision and relationship mutation.
- Google Drive permission synchronization.
- HPKE key-envelope distribution, rotation, and revocation.
- SPIFFE/SPIRE workload identity and mTLS.

## Primary references

- [OpenFGA concepts](https://openfga.dev/docs/concepts)
- [OpenFGA authorization model design principles](https://openfga.dev/docs/best-practices/modeling-design-principles)
- [OpenFGA model testing](https://openfga.dev/docs/modeling/testing)
- [OpenFGA Docker setup](https://openfga.dev/docs/getting-started/setup-openfga/docker)
- [OpenFGA check API](https://openfga.dev/docs/getting-started/perform-check)

## Completion criteria

- OpenFGA uses its isolated PostgreSQL database and pinned server image.
- Schema migration completes before the decision server starts.
- The model represents organizations, teams, workbooks, direct sharing, and
  inherited team access.
- Automated model tests prove expected allows and denials.
- Repeated provisioning reuses a semantically identical model version.
- API startup verifies the configured store/model boundary.
- The PEP derives the user from the product session and performs a
  higher-consistency `can_view` check.
- Live verification proves allowed, forbidden, and anonymous behavior.
- Unit, type, lint, format, build, infrastructure, and live checks pass.
