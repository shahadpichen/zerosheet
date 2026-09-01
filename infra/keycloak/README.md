# Keycloak local identity provider

This directory contains the reproducible local realm used to learn enterprise authentication before ZeroSheet adds Google federation.

## Why Keycloak is separate

Keycloak is an independent identity provider. It authenticates local users now and will broker Google, OIDC, and SAML identities later. ZeroSheet trusts Keycloak's issuer and signed tokens instead of receiving user passwords.

Keycloak uses the isolated `keycloak` database and the `keycloak_app` role. It cannot access the `zerosheet` or `openfga` databases.

## Why the realm file has no comments

JSON does not support comments. Adding non-standard comment properties could also make future Keycloak versions reject an otherwise valid import. The following sections therefore document the important fields in `realm/zerosheet-realm.json`.

### Realm settings

- `sslRequired: external` permits HTTP only for localhost/private development while requiring HTTPS for external requests.
- Self-registration is disabled because organization provisioning and invitations will be explicit enterprise workflows.
- Duplicate emails are disabled, but email is still not treated as the permanent identity key. ZeroSheet will map Keycloak's `(issuer, subject)` pair to an internal user ID.
- Brute-force protection introduces increasing waits after repeated failed passwords.
- Email verification is disabled only because `zerosheet.local` cannot receive mail. Production users must verify email or arrive from a verified upstream IdP.

### BFF client settings

- The client is confidential because the future API can protect a client secret. Browser JavaScript cannot.
- Authorization Code is the only enabled human login flow.
- PKCE `S256` binds the authorization code to the browser session that initiated login.
- Implicit flow is disabled because it exposes tokens through browser redirects.
- Direct Access Grant is disabled because sending passwords directly to the application defeats the IdP boundary.
- Service accounts are disabled because this client represents interactive ZeroSheet sessions, not workloads.
- Redirect URIs and web origins are exact local addresses. Broad wildcards would let an attacker redirect authorization results to another site.
- `fullScopeAllowed` is disabled so future client scopes must be deliberately assigned.

### Learner account

The imported learner account demonstrates Keycloak-owned username/password authentication. Its password comes from the ignored local `.env`, and `temporary: true` forces a password replacement on first interactive login.

This user is not a ZeroSheet product user yet. The internal product record and external-identity mapping are introduced when the API handles its first OIDC callback.

## Development versus production

The Compose profile runs `start-dev`, which enables HTTP and relaxed hostname/cache behavior. It is suitable only for the local laboratory.

The RackNerd deployment will use an optimized Keycloak image, HTTPS through Caddy, production hostname checks, mounted secrets, backups, and a larger memory limit.
