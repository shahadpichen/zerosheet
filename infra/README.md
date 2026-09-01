# Infrastructure

Infrastructure is introduced incrementally so each IAM service can be studied independently.

Planned Compose profiles:

- `auth-lab`: PostgreSQL, Keycloak, API, and Caddy.
- `authorization-lab`: PostgreSQL, OpenFGA, OPA, API, and Caddy.
- `governance-lab`: PostgreSQL, OpenFGA, OPA, API, and worker.
- `integrated-test`: the complete IAM stack for temporary end-to-end tests.

Milestone 1 will add PostgreSQL and Keycloak. Until then, this directory intentionally contains no runnable identity infrastructure.
