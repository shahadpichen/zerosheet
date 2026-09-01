# Milestone 1: PostgreSQL and Keycloak foundation

## Learning objective

Understand how a dedicated identity provider authenticates users, persists its own state, and exposes a standards-based OIDC interface without yet mixing authentication with ZeroSheet product authorization.

## Components

```text
Browser
  -> Keycloak :8080
       -> keycloak database

Future ZeroSheet API
  -> zerosheet database

Future OpenFGA
  -> openfga database
```

All three databases live in one PostgreSQL container to control cost. Separate owners and revoked public connection rights keep the logical security boundaries explicit.

## Keycloak concepts

- **Realm:** an isolated Keycloak security domain containing users, clients, policies, and keys. This laboratory creates the `zerosheet` realm.
- **User:** an identity Keycloak may authenticate. The learner account is local to Keycloak.
- **Client:** an application asking Keycloak to authenticate users. `zerosheet-bff` is confidential because the future API can protect a client secret.
- **Issuer:** the realm URL that names the authority signing identity tokens.
- **Discovery document:** machine-readable OIDC metadata listing authorization, token, logout, UserInfo, and JWKS endpoints.
- **JWKS:** public signing keys used to verify Keycloak tokens. These keys verify signatures; they do not decrypt ZeroSheet workbooks.

## Current request boundary

```text
Authorization request
  -> Keycloak validates client and callback
  -> Keycloak renders its login page
  -> milestone stops
```

ZeroSheet does not yet create `state`, `nonce`, a PKCE verifier, exchange a code, validate tokens, or create a product session. Those are Milestone 2 responsibilities.

## Local commands

```bash
cp .env.example .env
pnpm infra:auth:config
pnpm infra:auth:up
pnpm infra:auth:verify
pnpm infra:auth:logs
pnpm infra:auth:down
```

`infra:auth:down` stops containers but preserves PostgreSQL data. This is deliberate: a normal restart should retain users and Keycloak configuration.

Deleting the Docker volume is a destructive reset and is intentionally not exposed as a package script.

## Completion criteria

- PostgreSQL and Keycloak report healthy.
- Each service role connects to its own database.
- Cross-database connection attempts are denied.
- The realm discovery document has the expected issuer and endpoints.
- Keycloak publishes at least one public signing key.
- The BFF authorization request renders the Keycloak login flow, while an unknown client is rejected.
- Restarting the containers preserves the imported realm and learner account, verified through Keycloak's supported Admin API.
- No real secret is tracked by Git.
