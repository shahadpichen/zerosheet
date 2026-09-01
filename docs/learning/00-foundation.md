# Milestone 0: Foundation

## Learning objective

Understand the boundary between an unauthenticated HTTP service and the authentication and authorization systems that will later protect it.

## Current request flow

```text
GET /health -> ZeroSheet API -> static process-health response
```

The health endpoint proves that the process is running. It does not identify a user and must never expose database, token, or key material.

## Vocabulary

- **Principal:** a human or workload whose identity has been established.
- **Authentication:** proving who the principal is.
- **Authorization:** deciding whether that principal may perform an action.
- **PEP:** the component that enforces an authorization decision; this will be the API.
- **Trust boundary:** a point where data moves between systems with different security assumptions.

## Completion criteria

- The monorepo installs reproducibly.
- All packages type-check and build.
- The health-endpoint test passes.
- The initial trust boundaries and IAM component decision are documented.
