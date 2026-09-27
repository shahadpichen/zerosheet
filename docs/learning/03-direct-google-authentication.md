# Milestone 3: direct Google authentication

## Why the architecture changed

ZeroSheet currently supports one interactive provider: Google. Running an
identity broker added a JVM service, database, credentials, reverse-proxy host,
and a second authorization-code exchange without providing a required product
capability. ZeroSheet now talks directly to Google's OIDC service.

This is a deliberate scope decision, not a claim that brokers are useless.
Customer-specific SAML/OIDC federation may later justify a managed enterprise
broker, but application roles remain in ZeroSheet/OpenFGA either way.

## Protected flow

```text
1. Browser requests /auth/login/google.
2. ZeroSheet creates random state, nonce, and a PKCE verifier.
3. PostgreSQL stores the one-use transaction; the browser gets an HttpOnly
   random selector cookie.
4. The browser is redirected to Google with code flow and PKCE S256, requesting
   identity plus narrow Drive scopes when storage is enabled.
5. Google returns a short-lived authorization code to /auth/callback.
6. ZeroSheet atomically consumes the transaction and exchanges the code from
   the server using the confidential client.
7. openid-client verifies signature, issuer, audience, state, nonce, and PKCE.
8. ZeroSheet requires `sub`, a verified email, and the configured `hd` claim
   when domain restriction is enabled.
9. PostgreSQL maps `(https://accounts.google.com, sub)` to a product UUID.
10. With storage enabled, validate the same exchange's storage scopes and fresh
    refresh token, and save it encrypted for that product user.
11. Only then create a separately random opaque session.
```

Email is mutable profile data and never the identity key. Google's `sub` claim
is stable for the account and client, while the issuer prevents subjects from
different authorities from colliding.

## Hosted-domain behavior

`GOOGLE_OIDC_HOSTED_DOMAIN` has two effects:

1. The `hd` authorization parameter narrows Google's account chooser.
2. The callback requires the same domain in the signed ID-token claim.

The first behavior is UX; only the second is enforcement. Organization and
workbook membership must still be checked by OpenFGA/OPA after login.

## Identity cutover warning

An old broker subject and a direct Google subject are different identifiers.
ZeroSheet intentionally does not join them merely because their email strings
match. Email-only linking would let an identity-provider or address-reuse event
inherit another person's roles and encrypted workbook access.

This project has no production tenant data, so the development cutover creates
a fresh direct-Google product identity. A future production migration would
need an explicit authenticated account-linking ceremony or an operator-reviewed
mapping—not an automatic email update.

## What was removed

- The local and production Keycloak containers.
- The Keycloak PostgreSQL database/role and its secrets.
- Realm imports, broker provisioning scripts, and the identity subdomain.
- Broker hints and Keycloak logout redirects.
- The local password-based learner account.

## What remains unchanged

- BFF authorization-code flow, state, nonce, and PKCE.
- HttpOnly opaque ZeroSheet sessions.
- Product users keyed through external `(issuer, subject)` mappings.
- Organization/team/workbook roles in PostgreSQL and OpenFGA.
- OPA contextual checks, SCIM lifecycle APIs, SPIFFE workload identity, and
  browser-side workbook encryption.
- Encrypted Google Drive/Sheets token storage and the explicit reconnect flow.

## Cloud Console checklist

On the one shared ZeroSheet OAuth client:

- Application type: Web application.
- Local redirect: `http://localhost:3001/auth/callback`.
- Production redirect: `https://<zerosheet-domain>/api/auth/callback`.
- Identity scopes: `openid email profile`.

Also register the storage reconnect callback on that same client:

- Local redirect: `http://localhost:3001/google/storage/callback`.
- Production redirect: `https://<zerosheet-domain>/api/google/storage/callback`.
- Storage scopes: `drive.file` and `drive.appdata` only.

With storage enabled, the login request includes both sets of scopes and saves
storage authority before creating a session. Reconnect uses its own callback,
but the client ID and secret are shared. Use the actual API port (3101 when
3001 is occupied) in both local redirect entries.
