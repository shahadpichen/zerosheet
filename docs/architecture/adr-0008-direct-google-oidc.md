# ADR 0008: Use direct Google OIDC for human authentication

- Status: Accepted
- Date: 2026-09-26
- Supersedes: ADR 0001's Keycloak authentication decision

## Context

ZeroSheet currently exposes one human login method: Google. The previous
brokered design required an identity-server process, isolated database, realm
imports, administration credentials, a second public hostname, and two
authorization-code exchanges. None of those components owned ZeroSheet roles;
PostgreSQL, OpenFGA, and OPA already did.

## Decision

The ZeroSheet API/BFF is a confidential OIDC client of Google's fixed issuer.
It uses authorization code flow with state, nonce, and PKCE S256, validates the
ID token through `openid-client`, maps `(issuer, subject)` to a product UUID,
and gives the browser only an opaque HttpOnly session.

Google identity scopes remain separate from the second OAuth client used for
Drive/Sheets access. Application roles remain product authorization data:

- PostgreSQL owns lifecycle and organization metadata.
- OpenFGA owns relationship roles and resource permissions.
- OPA combines those relationships with current contextual facts.

## Consequences

- Local and production deployments no longer run an identity server or its
  database, credentials, proxy hostname, or administration plane.
- Google availability is directly part of the interactive-login dependency.
- Local password accounts and built-in SAML/customer-IdP brokering are removed.
- A future enterprise SAML/OIDC requirement needs an explicit broker or managed
  federation service, but it does not require moving product roles into tokens.
- Logout ends the ZeroSheet session only. The next request uses Google's
  account chooser rather than attempting a Google-wide logout.
- Broker subjects cannot be silently joined to Google subjects by email. Any
  production cutover requires explicit authenticated account linking.
