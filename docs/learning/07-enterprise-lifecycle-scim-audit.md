# Milestone 7: Enterprise lifecycle, SCIM, and audit evidence

## Learning objective

Understand how an enterprise directory creates, updates, suspends, and
reactivates product users without confusing identity proof, product
authorization, or encryption-key possession. Also understand why a security
event log must be tenant-authorized, append-only, and deliberately free of
credentials or protected content.

Milestones 2 and 3 answered:

```text
Who authenticated this browser session?
```

Milestones 4 through 6 answered:

```text
May that product user perform this action right now?
```

Milestone 7 adds:

```text
How does an enterprise directory manage a person's ZeroSheet lifecycle?
What access and sessions must change when employment state changes?
What evidence explains the security-sensitive decisions afterward?
```

## SCIM is not login

SCIM 2.0 is a provisioning protocol. An enterprise directory such as Microsoft
Entra ID, Okta, or another identity-management system acts as a SCIM client and
calls ZeroSheet in the background. It is not the browser's login protocol.

The responsibilities remain separate:

| Concern                  | Protocol or component    | ZeroSheet result                                              |
| ------------------------ | ------------------------ | ------------------------------------------------------------- |
| Interactive sign-in      | OIDC through Keycloak    | An opaque browser session identifies a product user.          |
| Enterprise provisioning  | SCIM 2.0 subset          | A directory-managed user and tenant lifecycle status exist.   |
| Durable relationships    | OpenFGA                  | Organization, team, and workbook relationships are evaluated. |
| Current lifecycle policy | PostgreSQL PIP plus OPA  | A suspended tenant membership overrides relationship allows.  |
| Decryption capability    | Future HPKE key envelope | Possession of authorization still does not reveal plaintext.  |

A SCIM bearer credential therefore cannot be used as a browser session, and a
successful OIDC login cannot call SCIM administration routes.

## The implemented SCIM surface

ZeroSheet implements a deliberately bounded User service:

- `GET /scim/v2/ServiceProviderConfig`
- `GET /scim/v2/ResourceTypes`
- `GET /scim/v2/Schemas`
- `GET /scim/v2/Schemas/{schema-urn}`
- `POST /scim/v2/Users`
- `GET /scim/v2/Users` with exact `externalId eq` or `userName eq` filtering
- `GET /scim/v2/Users/{id}`
- `PUT /scim/v2/Users/{id}`
- `PATCH /scim/v2/Users/{id}` for reviewed replace operations
- `DELETE /scim/v2/Users/{id}`, represented as soft deactivation

Requests and responses use `application/scim+json`. Errors use the SCIM error
schema and appropriate `scimType` values. Resources have stable ZeroSheet UUIDs,
weak version ETags, timestamps, and canonical locations.

The discovery document advertises only `User`. It does not claim SCIM Group
support. Directory groups are not automatically ZeroSheet teams, because a
directory administrator changing a group must not unexpectedly grant access to
encrypted workbooks. A later design can introduce reviewed group-to-team
mapping with explicit ownership and approval rules.

This is a standards-aligned subset, not a claim of complete RFC 7643/7644
coverage. Pagination inputs, sorting, bulk operations, password changes,
enterprise-user extensions, and Groups are deferred.

## Creating a tenant provisioning connection

Only a signed-in product user with the composed OpenFGA plus OPA
`can_manage_members` permission may call:

```text
POST /organizations/{organizationId}/scim/connections
```

ZeroSheet creates a credential shaped like:

```text
zs_scim_<connection UUID>.<cryptographically random secret>
```

The plaintext is returned once. PostgreSQL stores only its SHA-256 digest and a
short non-secret hint. Incoming credentials are hashed and looked up by digest;
the server cannot reconstruct the original credential from its database.

The credential is bound to one SCIM connection and therefore one organization.
Every managed-user query also includes that connection ID. A valid client for
Acme cannot enumerate or modify Globex provisioning records.

This credential is still a powerful long-lived bearer secret. Production needs
an administration surface for rotation, revocation, expiry, rate limits, and
secret-manager delivery. Those controls are not hidden behind the word SCIM.

## Joiner, mover, and leaver transitions

The lifecycle sequence is:

| Directory event               | PostgreSQL state                                             | Sessions                                                | OpenFGA state                                                                            | Effective result                                                          |
| ----------------------------- | ------------------------------------------------------------ | ------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Create active user            | Product user, SCIM mapping, and tenant status become active. | No browser session is invented.                         | Organization `member` is provisioned through the transactional outbox.                   | The user can authenticate separately and use allowed relationships.       |
| Replace profile               | Managed email/display metadata and SCIM version change.      | Existing sessions remain unless the result is inactive. | Membership is reconciled idempotently.                                                   | Directory retries converge on the same resource.                          |
| Set `active: false` or DELETE | Tenant status becomes `suspended`.                           | Every current session for that product user is deleted. | Organization membership is removed through the outbox, cascading tenant team membership. | Access is denied even if an unrelated direct workbook tuple still exists. |
| Set `active: true`            | Tenant status becomes `active`.                              | A fresh login is still required.                        | Organization membership is restored.                                                     | Existing independent shares can become usable again after authentication. |

The tenant lifecycle fact is scoped by `(organization_id, user_id)`. Removing a
consultant from one customer does not globally suspend a different customer's
relationship. ZeroSheet currently revokes all sessions during a leaver event,
which is intentionally conservative; the person may authenticate again for an
unaffected tenant.

## Why deactivation is fail-closed

The repository first commits the suspended PIP fact and deletes sessions in one
PostgreSQL transaction. It then asks the existing ProductService coordinator to
remove relationships using the durable outbox.

If OpenFGA is temporarily unavailable:

1. the user's old sessions are already invalid;
2. any newly authenticated session sees `organizationStatus: suspended`;
3. OPA denies even if a direct workbook relationship remains; and
4. the outbox retains the relationship cleanup for safe idempotent retry.

Activation uses the opposite safe failure mode. PostgreSQL can say active
before a failed relationship write, but missing OpenFGA membership cannot grant
anything. One subsystem being ahead of the other never becomes permission.

## Account linking is deliberately strict

A SCIM `userName` is directory data, not proof that an existing Keycloak/OIDC
identity is the same human. Milestone 7 creates a directory-managed product
user and does not silently attach it to an existing `(issuer, subject)` merely
because email strings match.

Safe production linking needs a reviewed invitation or provider-specific
correlation flow. Email-only automatic linking would let identity-provider
changes, aliases, or recycled addresses connect the wrong authentication
identity to encrypted workbook authorization.

## Security audit events

ZeroSheet records security-relevant outcomes such as:

- composed authorization allows and denials;
- SCIM connection creation;
- user create, replace, deactivate, and reactivation; and
- failed relationship synchronization.

Each event contains a generated ID, monotonic sequence, timestamp, actor type
and ID, optional organization, action, resource reference, outcome, reason
code, and a small primitive-only details object. Services must not copy bearer
tokens, session values, OIDC codes, private keys, recovery phrases, plaintext
cells, request bodies, or exception objects into that field.

Tenant audit export is protected by the same composed `can_manage_members`
decision as SCIM connection creation:

```text
GET /organizations/{organizationId}/audit-events
```

Sequence-cursor pagination avoids offset races while events are appended. A
database trigger rejects ordinary UPDATE and DELETE statements, including from
the current application owner role.

The trigger is defense in depth, not an immutable-storage guarantee against a
database owner who can alter schema. Production should give the runtime a
non-owner append-only role and export signed or write-once copies to a separate
security destination with retention and access controls.

## Database responsibilities

- `scim_connections` stores organization binding, credential digest, hint, and
  connection state.
- `scim_managed_users` maps stable SCIM resource IDs to product-user IDs and
  stores directory lifecycle/profile state.
- `organization_user_lifecycle` is the tenant-scoped PIP fact consumed by OPA.
- `security_audit_events` is append-only security evidence.
- Existing `organization_members` and `relationship_outbox` tables remain the
  source of product relationship mutation intent.

Keycloak still owns authentication identities in its separate database.
OpenFGA still owns the applied relationship graph in its separate database.
SCIM does not move those responsibilities into the ZeroSheet product schema.

## Commands and verification

```bash
pnpm infra:authorization:up
pnpm infra:db:migrate
pnpm dev:api
pnpm infra:lifecycle:verify
pnpm lint
pnpm typecheck
pnpm test
```

The live verifier proves:

1. only the credential digest is stored;
2. active SCIM provisioning creates product and OpenFGA membership state;
3. a managed user with a direct workbook share can read while active;
4. suspension deletes the old session and removes organization membership;
5. OPA denies a newly seeded session while the direct OpenFGA share remains;
6. reactivation restores membership and access on the stable SCIM resource;
7. an authorized tenant administrator can export the expected evidence; and
8. PostgreSQL rejects an attempted audit-event UPDATE.

## Security invariants

1. SCIM is provisioning, not authentication.
2. A provisioning credential is tenant-bound, stored only as a digest, and
   never exposed again after creation.
3. Every managed-user read or write is scoped by connection ID.
4. Directory activity changes product lifecycle; it does not directly write
   arbitrary OpenFGA tuples.
5. Deactivation writes the deny fact and revokes sessions before relationship
   cleanup, so dependency failure remains fail-closed.
6. Reactivation requires both a fresh session and the required relationship.
7. Directory email alone never links an OIDC identity.
8. Audit export is itself an authorized product action.
9. Audit details exclude credentials, cryptographic material, and content.
10. Ordinary application DML cannot update or delete recorded evidence.

## Deliberately deferred

- SCIM Groups and reviewed directory-group-to-ZeroSheet-team mapping.
- Connection listing, expiry, rotation, revocation, and secret-manager delivery.
- Pagination parameters, sorting, bulk operations, password change, and SCIM
  enterprise-user extensions.
- Safe invitation/correlation between pre-provisioned SCIM users and later OIDC
  identities.
- Asynchronous reconciliation dashboards and dead-letter administration.
- Separate append-only database roles and signed external audit retention.
- Step-up authentication and approval workflows for sensitive administration.
- SPIFFE/SPIRE workload identity and mTLS, which begin in Milestone 8.
