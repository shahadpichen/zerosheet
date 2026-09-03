# Single-node alpha operations

This directory contains the production-shaped Compose and Caddy configuration.
The complete teaching, bootstrap, Google, backup, restore, and residual-risk
guide is [Milestone 14](../../docs/learning/14-developer-sdk-production-release.md).

## Files

- `compose.yaml`: only Caddy publishes 80/443; all credentials are file mounts.
- `Caddyfile`: same-origin `/api`, separate identity hostname, TLS, CSP, HSTS,
  bounded static caching, and a blocked public Keycloak admin surface.
- `environment.example`: names/non-secret IDs only; copy outside the checkout.

Do not run this topology with the example domains, OpenFGA IDs, or Google
client IDs. Generate secret files with
`infra/scripts/generate-production-secrets.sh`, complete the bootstrap in the
learning guide, and keep the resulting environment file root-owned.

The generator creates a root-owned `0700` directory containing `0444` files.
That combination is intentional: other host users cannot traverse the secret
directory, while Compose can bind-mount an explicitly granted file for a
service running under its own non-root UID. Do not loosen the directory mode.

The deployment is deliberately labeled **single-node alpha**. Its conservative
limits can fit an idle learning stack near a 2 GB VPS boundary, but it has no
host, database, or identity-service redundancy. Upgrade resources and topology
before promising availability or adding sustained traffic.
