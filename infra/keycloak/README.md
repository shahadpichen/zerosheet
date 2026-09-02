# Keycloak local identity provider

This directory contains the reproducible local realm used to learn enterprise
authentication and Google identity brokering.

## Why Keycloak is separate

Keycloak is an independent identity provider. It authenticates local users now and will broker Google, OIDC, and SAML identities later. ZeroSheet trusts Keycloak's issuer and signed tokens instead of receiving user passwords.

Keycloak uses the isolated `keycloak` database and the `keycloak_app` role. It cannot access the `zerosheet` or `openfga` databases.

## Google identity brokering

Google is an upstream identity provider; Keycloak remains ZeroSheet's trusted
issuer. The browser may ask Keycloak to begin with Google by using the fixed
`kc_idp_hint=google`, but Google still returns to Keycloak's broker callback and
Keycloak still issues the authorization code consumed by ZeroSheet.

The realm template contains one disabled Google provider so a fresh local realm
has the correct structure without pretending placeholder credentials work.
Existing realms are not overwritten by startup import. Run
`pnpm infra:federation:google:configure` to create or update the provider through
the supported Admin REST API, or `pnpm infra:federation:google:verify` to apply
and read back all security-relevant settings.

The provider requests only `openid profile email`, does not store Google's
access token, and uses Keycloak's protected first-broker-login flow. Google Drive
access will be a separate OAuth connection rather than an extra login scope.

## Why the realm file has no comments

JSON does not support comments. Adding non-standard comment properties could also make future Keycloak versions reject an otherwise valid import. The following sections therefore document the important fields in `realm/zerosheet-realm.json`.

### Realm settings

- `sslRequired: external` permits HTTP only for localhost/private development while requiring HTTPS for external requests.
- Self-registration is disabled because organization provisioning and invitations will be explicit enterprise workflows.
- Duplicate emails are disabled, but email is still not treated as the permanent identity key. ZeroSheet will map Keycloak's `(issuer, subject)` pair to an internal user ID.
- Brute-force protection introduces increasing waits after repeated failed passwords.
- Email verification is disabled only because `zerosheet.local` cannot receive mail. Production users must verify email or arrive from a verified upstream IdP.

### BFF client settings

- The client is confidential because the API/BFF protects its client secret. Browser JavaScript never receives it.
- Authorization Code is the only enabled human login flow.
- PKCE `S256` binds the authorization code to the browser session that initiated login.
- Implicit flow is disabled because it exposes tokens through browser redirects.
- Direct Access Grant is disabled because sending passwords directly to the application defeats the IdP boundary.
- Service accounts are disabled because this client represents interactive ZeroSheet sessions, not workloads.
- Redirect URIs and web origins are exact local addresses. Broad wildcards would let an attacker redirect authorization results to another site.
- `fullScopeAllowed` is disabled so future client scopes must be deliberately assigned.

### Learner account

The imported learner account demonstrates Keycloak-owned username/password authentication. Its password comes from the ignored local `.env`, and `temporary: true` forces a password replacement on first interactive login.

The first successful OIDC callback maps this Keycloak identity to a separate ZeroSheet product user by `(issuer, subject)`. Keycloak remains the authentication authority; the product database does not copy its password credential.

## Development versus production

The Compose profile runs `start-dev`, which enables HTTP and relaxed hostname/cache behavior. It is suitable only for the local laboratory.

The RackNerd deployment will use an optimized Keycloak image, HTTPS through
Caddy, production hostname checks, mounted secrets, backups, a separate Google
production OAuth client, and a larger memory limit.
