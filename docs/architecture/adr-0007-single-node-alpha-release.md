# ADR 0007: Ship a hardened single-node alpha without claiming high availability

- Status: accepted
- Date: 2026-09-03

## Context

The first deployment target is an inexpensive 2 GB KVM VPS. ZeroSheet still
needs public TLS, Keycloak, two policy engines, three isolated databases, the
API, static web assets, backup/restore evidence, mounted secrets, and bounded
resource usage. A design sized like a multi-region enterprise platform would
make learning and early product validation unnecessarily expensive; calling a
single VPS “production ready” would be equally misleading.

## Decision

The repository provides a single-node alpha Compose topology:

- Caddy is the only public process and owns automatic HTTPS for separate app
  and identity hostnames.
- The browser and API share one public origin; Caddy strips `/api`, preserving
  host-only Secure cookies and avoiding credentialed cross-origin requests.
- PostgreSQL is one process with isolated databases/owners for ZeroSheet,
  Keycloak, and OpenFGA. A fourth login can execute only an aggregate security
  drift function and has no table `SELECT` grant.
- API, OpenFGA, and OPA share one pod-like Docker network namespace. Both PDPs
  bind to loopback, so their local HTTP traffic cannot traverse a bridge.
- Credentials arrive through allowlisted mounted files. Images are pinned,
  multi-stage, non-root/read-only where possible, memory-limited, and use
  bounded logs.
- The worker is a one-shot operations profile rather than a permanent process.
- Logical database dumps must be age-encrypted and pass a restore drill in a
  disposable networkless PostgreSQL container.

## Consequences

- The topology is suitable for a learning deployment and limited alpha, not a
  high-availability SLA. One host, disk, PostgreSQL process, Caddy instance, or
  Keycloak process is still a single point of failure.
- Memory pressure is visible rather than hidden. Sustained traffic should move
  to at least 4 GB or managed services before adding swap as a blanket fix.
- The SPIFFE/mTLS lab remains the multi-process/multi-node pattern. If PDPs move
  out of the shared namespace, loopback HTTP is no longer allowed and the link
  must use authenticated TLS.
- Compose secret files keep values out of image layers and service definitions,
  but the running process necessarily holds its own credential in memory.
- No deployment is performed automatically; DNS, firewall, Google clients,
  off-site backup storage, monitoring, and incident ownership are operator
  responsibilities.

## Alternatives rejected

### Publish every service port and rely on the VPS firewall

This adds a second fragile security boundary and makes accidental firewall
changes externally expose databases and PDPs. Only the reverse proxy needs a
host port.

### Put every service in one process/container

That would erase separate lifecycle, resource, credential, and compromise
boundaries for Keycloak, policy engines, application code, and PostgreSQL.

### Advertise the 2 GB node as scalable production

Vertical upgrade and later service separation are possible, but neither is
high availability. The operational label must describe current failure modes.
