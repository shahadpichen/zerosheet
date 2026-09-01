# ADR 0001: Separate authentication and authorization components

- Status: Accepted
- Date: 2026-09-01

## Decision

Use Keycloak as ZeroSheet's OIDC identity provider and identity broker, OpenFGA for durable relationships, OPA for contextual policy, and the ZeroSheet API as the policy enforcement point.

## Why

Authentication proves who is making a request. Authorization decides what that principal can do. Keeping these decisions separate prevents provider login configuration or token claims from becoming the permanent source of workbook permissions.

## Consequences

- ZeroSheet integrates with one OIDC issuer even when organizations use different upstream providers.
- Application permissions are checked at request time instead of copied into long-lived tokens.
- The deployment has more services, so local labs and the 2 GB staging VPS use Compose profiles.
