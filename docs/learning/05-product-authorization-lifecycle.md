# Milestone 5: Product and relationship lifecycle

## Learning objective

Understand how an enterprise application creates product resources and changes
authorization relationships when PostgreSQL and the authorization server are
independent systems.

Milestone 4 proved a read-time decision:

```text
user + permission + workbook -> OpenFGA allow or deny
```

Milestone 5 creates and removes the relationships that make those decisions
useful:

```text
create an organization -> creator becomes owner
create a team         -> team belongs to organization; creator becomes manager
create a workbook     -> workbook belongs to organization; creator becomes owner
add a team member     -> team shares can authorize that member
remove a member       -> inherited authorization paths disappear
share a workbook      -> direct user or team userset receives a fixed role
```

## Two sources of truth with different jobs

PostgreSQL and OpenFGA do not duplicate the same responsibility.

PostgreSQL owns product/control-plane state:

- organization, team, and workbook names;
- which organization contains a team or workbook;
- lifecycle state such as `pending` or `active`;
- the desired role attached to a membership/share; and
- durable relationship mutation intents.

OpenFGA owns the relationship graph used for access decisions:

- organization owner, admin, and member tuples;
- team manager and member tuples;
- workbook owner, editor, and viewer tuples; and
- containment/userset edges used by the authorization model.

Neither database stores workbook plaintext, a workbook content key, an HPKE
private key, or the 12-word recovery secret.

## Why one normal transaction is impossible

A PostgreSQL transaction can atomically change tables inside the ZeroSheet
database. An OpenFGA write is a network request to another server and another
database. This sequence is unsafe:

```text
commit PostgreSQL
call OpenFGA
```

The process can stop between the two steps. Reversing the order has the same
problem in the other direction. This is the dual-write problem.

Milestone 5 uses a transactional outbox:

```text
PostgreSQL transaction
  -> write pending product state
  -> write exact OpenFGA tuple intent to relationship_outbox
  -> commit both together

API
  -> replay tuple intent to OpenFGA
  -> mark outbox applied
  -> activate product state
  -> return success
```

Normal reads return only `active` rows. A half-provisioned resource therefore
does not become visible merely because PostgreSQL contains a name.

## The ambiguous-success window

A network timeout does not prove that OpenFGA rejected a write. OpenFGA may
have committed it and lost the response on the way back.

ZeroSheet handles that ambiguity by making each outbox intent replayable:

- duplicate tuple writes are treated as successful no-ops;
- deletes of already-missing tuples are treated as successful no-ops;
- a role replacement sends its write and delete together when within the
  OpenFGA transaction bound;
- a PostgreSQL row is activated only by the operation UUID that staged it; and
- two reconcilers may replay the same intent without creating more privilege.

For a large leaver operation, the SDK serially chunks more than 100 tuples. A
partial result leaves the outbox pending, and replay converges the remaining
tuples before PostgreSQL reports completion.

The API retries due intents every five seconds while it is running and once
before accepting requests at startup. This makes the first deployment
self-healing on the small VPS. Moving the same outbox processor into the
existing worker is a later operational scaling step; the durable protocol does
not change.

## Product lifecycle states

Entities use:

```text
pending -> active
```

Relationship records use:

```text
pending        -> active
active         -> pending_delete -> physically deleted
```

If OpenFGA is unavailable, the API returns HTTP 503 and leaves the operation
pending. It does not return a false success and does not expose pending product
metadata.

If the same `PUT` requests a role that is already active, the operation returns
success without creating another outbox row or rewriting OpenFGA.

## API Policy Enforcement Points

Every route derives the actor from the opaque HttpOnly product session. The
browser may provide UUIDs, names, and one of the closed role values; it cannot
provide an OpenFGA tuple, subject expression, relation name, creator, owner
role, or lifecycle state.

| Action                         | Route                                                     | Required relationship permission |
| ------------------------------ | --------------------------------------------------------- | -------------------------------- |
| Create organization            | `POST /organizations`                                     | authenticated product user       |
| Add/change organization member | `PUT /organizations/:organizationId/members/:userId`      | `can_manage_members`             |
| Remove organization member     | `DELETE /organizations/:organizationId/members/:userId`   | `can_manage_members`             |
| Create team                    | `POST /organizations/:organizationId/teams`               | `can_manage_members`             |
| Add/change team member         | `PUT /teams/:teamId/members/:userId`                      | team `can_manage`                |
| Remove team member             | `DELETE /teams/:teamId/members/:userId`                   | team `can_manage`                |
| Create workbook                | `POST /organizations/:organizationId/workbooks`           | `can_create_workbook`            |
| Read workbook metadata         | `GET /workbooks/:workbookId`                              | `can_view`                       |
| Add/change user share          | `PUT /workbooks/:workbookId/shares/users/:principalId`    | `can_manage_sharing`             |
| Remove user share              | `DELETE /workbooks/:workbookId/shares/users/:principalId` | `can_manage_sharing`             |
| Add/change team share          | `PUT /workbooks/:workbookId/shares/teams/:principalId`    | `can_manage_sharing`             |
| Remove team share              | `DELETE /workbooks/:workbookId/shares/teams/:principalId` | `can_manage_sharing`             |

Names are trimmed and bounded to 200 characters. All IDs must be UUIDs. Request
objects reject unrecognized fields, so a payload cannot smuggle `owner` or a
raw `relation` alongside an otherwise valid role.

## Why `PUT` is used for memberships and shares

A user has at most one direct role in an organization or team, and one direct
share role on a workbook. `PUT` expresses replacement of that complete role:

```text
member -> admin
viewer -> editor
```

The service locks the current PostgreSQL row, builds one write/delete intent,
and prevents another change while synchronization is pending. This avoids two
concurrent requests independently reading an old role and leaving two direct
roles in OpenFGA.

Organization ownership is deliberately excluded from these APIs. Changing or
removing an owner needs a separate transfer workflow with last-owner checks,
re-authentication, and audit evidence.

## Joiner, mover, and leaver behavior

### Joiner

An organization owner/admin can add a product user as `member` or `admin`. A
team member must already be an active member of the team's organization.

### Mover

A `PUT` can replace organization, team, or share roles. OpenFGA receives the
new tuple and deletion of the previous direct tuple as one recorded intent.

### Leaver

Removing an organization member also finds and removes every team membership
that user has in that organization. This is essential because a team userset
may grant access to many workbooks:

```text
user removed from organization
  -> remove organization member tuple
  -> remove all team member/manager tuples in that organization
  -> every team-inherited workbook path disappears
```

Direct workbook shares deliberately remain. The model supports an explicitly
shared external collaborator who is not an organization member. Removing that
access requires deleting the explicit workbook share.

## Team sharing and usersets

A team share does not create one workbook tuple per member. It writes:

```text
team:<team-uuid>#member  editor  workbook:<workbook-uuid>
```

OpenFGA resolves current team membership at decision time. Adding or removing a
team member therefore affects every team-shared workbook without scanning those
workbooks in PostgreSQL.

A team may be shared only to a workbook in the same organization. Direct user
shares may target an existing ZeroSheet user outside the organization.

## Error and privacy behavior

- `400 invalid_request`: malformed UUID, name, role, or extra field.
- `401`: no valid opaque product session; OpenFGA is not called.
- `403 forbidden`: the fixed permission decision denied the action.
- `404 not_found`: authorized workflow referenced missing or non-active product
  state.
- `409 conflict`: immutable ownership, cross-organization team share, duplicate
  team name, or another pending mutation prevents the transition.
- `503 authorization_unavailable`: the intent is durable but OpenFGA
  synchronization has not completed.

Public errors never reveal SQL constraint names, raw OpenFGA errors, tuple
existence, credentials, or another tenant's metadata.

## Relationship outbox validation

Outbox tuples are JSONB so they can be replayed exactly. Before replay, the API
accepts only the reviewed grammar:

- UUID-addressed `user`, `organization`, `team`, and `workbook` objects;
- direct relations defined in the current model; and
- `team:<uuid>#member` usersets only for workbook `editor` or `viewer`.

Malformed or tampered payloads fail closed instead of becoming arbitrary
OpenFGA writes.

## Encryption and Google Drive remain separate controls

An active viewer/editor relationship is necessary for workbook access, but it
is still not sufficient to decrypt encrypted cells.

Future sharing requires all applicable controls to agree:

```text
OpenFGA permits the product action
AND
the recipient has an HPKE-wrapped workbook-key envelope
AND
Google Drive permission synchronization permits the storage operation
```

This milestone stores workbook metadata only. It does not store or distribute a
workbook key and does not call Google Drive.

## Commands and verification

```bash
pnpm infra:authorization:up
pnpm infra:authorization:provision
pnpm infra:db:migrate
pnpm dev:api
pnpm infra:product:verify
```

The live verifier seeds only temporary product users and opaque sessions. All
organization, team, workbook, membership, sharing, and revocation operations
then use the public API. It proves:

1. creation activates PostgreSQL metadata and OpenFGA tuples;
2. a team share grants inherited workbook access;
3. removing the organization member cascades team membership revocation;
4. a direct external share grants access;
5. deleting that direct share revokes access;
6. no relevant outbox intent remains pending; and
7. an anonymous mutation is rejected.

## Security invariants

1. The session chooses the actor; an HTTP body never chooses the OpenFGA user.
2. Product state and tuple intent commit together in PostgreSQL.
3. Pending resources are not readable as active product state.
4. Tuple replay is idempotent and fails closed on partial failure.
5. Only the operation that staged a row may activate it.
6. Authorization is checked before every administrative mutation.
7. A team member must be an active member of the same organization.
8. Organization removal deletes that user's tenant team paths.
9. Organization administration still does not imply workbook visibility.
10. Relationship state contains no encryption keys, plaintext, or OAuth tokens.

## Deliberately deferred

- Organization invitations and acceptance workflows.
- Ownership transfer and last-owner protection.
- User suspension, SCIM, and identity-governance approvals.
- Permission-aware workbook listing with OpenFGA `ListObjects`.
- OPA contextual policy for tenant status, device, time, and risk.
- Dedicated audit events and security-event export.
- Moving the retry loop from the API process into the worker deployment.
- Google Drive permission synchronization and conflict handling.
- HPKE key envelopes, rotation, recovery, and revocation.
- SPIFFE/SPIRE workload identity and mTLS.

## Completion criteria

- Migration 002 creates product, relationship, and outbox state with strict
  foreign keys/check constraints.
- API startup refuses to run without the migration.
- Creation writes containment plus initial owner/manager relationships.
- Role changes and removals use durable, idempotent tuple intents.
- Organization leavers lose all tenant team membership paths.
- Workbook metadata is returned only after `can_view` and active-state checks.
- Unit tests cover tuple mapping, PEP behavior, denial, retry, and replay.
- Live verification proves inherited/direct access and revocation.
- Lint, type, format, unit, model, build, migration, and infrastructure checks
  pass.
