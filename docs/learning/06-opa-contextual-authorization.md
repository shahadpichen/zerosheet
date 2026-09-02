# Milestone 6: OPA contextual authorization

## Learning objective

Understand why enterprise authorization needs both durable relationships and
current context, how PDP/PEP/PIP/PAP responsibilities differ, and how ZeroSheet
combines OpenFGA, PostgreSQL, and OPA without allowing one partial decision to
grant access by itself.

Milestone 5 answered relationship questions such as:

```text
Does this user own, edit, or view this workbook?
```

Milestone 6 adds operational questions:

```text
Is this product account active right now?
Is the organization allowed to operate right now?
Is this action valid for this kind of resource?
```

The resulting rule is:

```text
authenticated session
AND OpenFGA relationship allow (for existing resources)
AND PostgreSQL context exists
AND OPA contextual allow
= permit the product action
```

Any false, missing, malformed, timed-out, or unavailable required component
prevents permission.

## What OPA is

Open Policy Agent (OPA) is a general-purpose policy decision server. ZeroSheet
sends it structured JSON input and asks for one reviewed decision rule. OPA is
not an authentication library, an identity provider, a user database, or a
replacement for OpenFGA.

OPA evaluates Rego policy. Rego is useful here because contextual rules can be:

- version controlled and code reviewed;
- tested in the real policy engine without starting the application;
- changed independently from route implementation; and
- default-deny for unknown input.

The local container is stateless. It mounts `infra/opa` read-only and stores no
accounts, sessions, memberships, workbook contents, or secrets.

## The four policy roles

Enterprise IAM literature commonly uses four related names:

| Role                             | ZeroSheet component                                     | Responsibility                                                                                                    |
| -------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| PEP: Policy Enforcement Point    | ZeroSheet API                                           | Intercepts a protected action, derives the session principal, requests decisions, and returns success or denial.  |
| PDP: Policy Decision Point       | OpenFGA and OPA, composed by the authorization service  | OpenFGA decides relationships; OPA decides contextual policy.                                                     |
| PIP: Policy Information Point    | PostgreSQL policy-context repository                    | Supplies current account and tenant lifecycle facts.                                                              |
| PAP: Policy Administration Point | Reviewed Rego/model files and their deployment workflow | Defines, tests, approves, and publishes policy. A future admin UI may propose changes but must not bypass review. |

The API is not trusting a browser-provided policy fact. It obtains the user ID
from the opaque server session, asks OpenFGA itself, and reads status itself.

## Why OpenFGA and OPA are both present

OpenFGA is designed for a graph that changes through product relationships:

```text
user is member of team
team is editor of workbook
user can edit workbook
```

OPA is designed for rules over request-time facts:

```text
account is active
organization is active
relationship decision is true
action belongs to this resource type
```

Encoding suspension by deleting every OpenFGA tuple would lose the underlying
business relationships and require reconstructing them during reactivation.
Keeping status in PostgreSQL makes suspension immediate and reversible while
OpenFGA continues to answer the relationship question accurately.

## Status versus synchronization state

Two similarly named concepts must not be combined:

- `authorization_state` says whether a PostgreSQL product change and its
  OpenFGA tuple mutation have converged (`pending` or `active`).
- `account_status` and `tenant_status` say whether an otherwise valid account
  or organization may operate (`active` or `suspended`).

For example, a workbook can have active, fully synchronized owner tuples while
its organization is suspended. OpenFGA correctly returns `allowed: true`, but
OPA returns false and the API responds with HTTP 403.

## The policy input contract

OPA receives a minimized document shaped like this:

```json
{
  "subject": { "id": "product-user-id", "status": "active" },
  "organization": { "id": "organization-id", "status": "active" },
  "resource": { "type": "workbook", "id": "workbook-id" },
  "action": "can_view",
  "relationship": { "required": true, "allowed": true }
}
```

It does not receive names, email addresses, Keycloak tokens, session tokens,
OpenFGA tuples, workbook content, Google tokens, or encryption material.

`create_organization` is special because an organization and its OpenFGA owner
tuple do not exist yet. Its input uses the fixed platform resource and
`relationship.required: false`. It still requires an active product account.

All existing-resource actions require `relationship.required: true` and an
explicit `relationship.allowed: true`.

## Closed actions and default denial

TypeScript and Rego both use a closed set of reviewed mappings:

| Resource     | Accepted actions                             |
| ------------ | -------------------------------------------- |
| platform     | `create_organization`                        |
| organization | `can_manage_members`, `can_create_workbook`  |
| team         | `can_manage`                                 |
| workbook     | `can_view`, `can_edit`, `can_manage_sharing` |

An HTTP caller cannot invent a relation or action. A future action added in
TypeScript but forgotten in Rego remains denied, which is safer than silently
granting it.

## Decision sequence

For an existing resource, the authorization service performs:

```text
1. Ask OpenFGA using the session-derived product user ID.
2. If OpenFGA denies, stop and deny.
3. Ask PostgreSQL for the account, resource, and containing tenant status.
4. If any required row is absent or product metadata is pending, deny.
5. Send the minimized facts and explicit relationship allow to OPA.
6. Permit only when OPA's JSON result is exactly boolean true.
```

Network or HTTP failures propagate as dependency failures. A successful OPA
response containing false, no result, invalid JSON, or a non-boolean value is
never treated as permission.

The short-circuit after OpenFGA denial avoids unnecessary database and policy
requests and reduces resource-existence side channels.

## Deployment boundary

The learning environment pins `openpolicyagent/opa:1.20.1`, mounts policy
read-only, removes Linux capabilities, and publishes port 8181 only on
`127.0.0.1`. Local OPA has no API credential, so it must not be bound to a LAN
or public interface.

Production will keep OPA on a private network and authenticate workloads with
the later SPIFFE/SPIRE and mTLS milestone. HTTPS is required by configuration
for a non-loopback OPA URL.

OPA readiness has two parts:

1. OPA's built-in `/health` proves the server is operational. The
   `/health/ready` convention instead requires a separately authored
   `data.system.health.ready` rule, which this disk-mounted policy does not
   need.
2. A synthetic, non-resource allow proves the exact ZeroSheet package and rule
   were loaded before the API accepts traffic.

## Commands and verification

```bash
pnpm infra:contextual-authorization:policy:test
pnpm infra:authorization:up
pnpm infra:db:migrate
pnpm dev:api
pnpm infra:contextual-authorization:verify
```

The policy test runs nine cases directly in OPA. The TypeScript suite covers
decision composition, minimized context, malformed responses, dependency
errors, and the PostgreSQL projection.

The live verifier proves:

1. active account plus active tenant plus owner relationship allows access;
2. tenant suspension denies while OpenFGA still explicitly allows the owner;
3. account suspension denies existing access and organization creation; and
4. reactivation restores access without rebuilding relationships.

## Security invariants

1. The browser supplies none of the authoritative policy facts.
2. Existing-resource permission requires an explicit OpenFGA allow and OPA
   allow.
3. Missing PIP rows and non-active product metadata deny access.
4. Suspensions preserve relationships and are reversible.
5. OPA input contains only the minimum facts required by policy.
6. OPA must return the literal boolean `true`; no truthy coercion is allowed.
7. Unknown action/resource combinations remain denied.
8. OPA unavailability never degrades into permission.

## Deliberately deferred

- Administrative suspension APIs, approval workflows, and audit events.
- SCIM provisioning and deprovisioning.
- Device posture, IP/network zone, time-window, and risk signals.
- Step-up authentication for sensitive administration.
- Fine-grained policy bundles, signed distribution, and rollback automation.
- SPIFFE/SPIRE workload identity and mTLS between internal services.
- Google Drive permission synchronization and HPKE key-envelope possession.

Those additions expand the PIP facts and Rego rules; they do not change the
deny-overrides composition established here.
