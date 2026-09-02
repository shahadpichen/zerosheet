# ADR 0001: Separate authentication and authorization components

- Status: Accepted
- Date: 2026-09-01

## Decision

Use Keycloak as ZeroSheet's OIDC identity provider and identity broker, OpenFGA
for durable relationships, OPA for contextual policy, SPIRE as the SPIFFE
workload-identity issuer, and the ZeroSheet API as the policy enforcement point.

## Why

Authentication proves who is making a request. Authorization decides what that principal can do. Keeping these decisions separate prevents provider login configuration or token claims from becoming the permanent source of workbook permissions.

## Consequences

- ZeroSheet integrates with one OIDC issuer even when organizations use different upstream providers.
- Application permissions are checked at request time instead of copied into long-lived tokens.
- Existing-resource actions require OpenFGA and OPA to agree; PostgreSQL supplies current lifecycle facts as the PIP.
- Enterprise directories provision tenant lifecycle through a bounded SCIM
  User service; they do not become the interactive OIDC issuer or write raw
  OpenFGA relationships.
- Security decisions and lifecycle transitions append tenant-scoped audit
  evidence that is exported only after a composed administration decision.
- API and worker processes receive separate, selector-bound, short-lived
  X.509-SVIDs from a local SPIRE agent instead of sharing a workload password.
- Private API-to-worker calls use those SVIDs for TLS 1.3 mutual authentication
  and exact URI-SAN authorization. Trust-domain membership alone does not grant
  access to a workload endpoint.
- The deployment has more services, so local labs and the 2 GB staging VPS use Compose profiles.
