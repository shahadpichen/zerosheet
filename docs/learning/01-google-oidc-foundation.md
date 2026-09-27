# Milestone 1: direct Google OIDC foundation

## Goal

Understand the smallest secure human-authentication boundary for ZeroSheet:
Google proves who the person is, while ZeroSheet owns its product user, opaque
browser session, organization roles, and workbook permissions.

## Runtime shape

```text
Browser
  -> ZeroSheet /auth/login/google
  -> Google authorization endpoint
  -> ZeroSheet /auth/callback
  -> Google token endpoint (server-to-server)
  -> ZeroSheet product user + opaque session
```

There is no local identity-server container. The API uses Google's fixed OIDC
discovery document at `https://accounts.google.com/.well-known/openid-configuration`
and trusts only the issuer returned for that authority.

## What Google owns

- Account authentication, including Google's own password/passkey/MFA policy.
- The signed ID token containing `iss`, `sub`, `aud`, `nonce`, email, and basic
  profile claims.
- Public signing keys published through the discovery document's `jwks_uri`.

Google does **not** own ZeroSheet roles. A valid Google login proves identity;
it does not automatically grant access to an organization or workbook.

## What ZeroSheet owns

- A random product-user UUID independent from the Google subject.
- The durable external identity key `(issuer, subject)`.
- One-use state, nonce, and PKCE login transactions.
- Opaque browser sessions whose SHA-256 selectors are stored in PostgreSQL.
- Organization/team metadata in PostgreSQL.
- Relationship roles and workbook permissions in OpenFGA.
- Runtime contextual decisions in OPA.

The login callback never exposes Google's client secret, refresh token, or ID
token. It sets only an HttpOnly session cookie. When storage is enabled, the
authenticated browser later obtains a short-lived API token through the BFF's
protected storage endpoint, not through a URL or persistent browser storage.

## Local Google Cloud setup

Create one **Web application** OAuth client for ZeroSheet and register this
exact redirect URI:

```text
http://localhost:3001/auth/callback
```

Put its client ID and secret in the ignored `.env` file:

```dotenv
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
GOOGLE_OIDC_HOSTED_DOMAIN=
```

Leave the hosted domain empty for consumer and Workspace accounts. If it is
set, ZeroSheet sends it as an account-selection hint and independently requires
the matching signed `hd` claim before creating a session.

On that same client, also register the Drive/Sheets reconnect callback:

```text
http://localhost:3001/google/storage/callback
```

With `GOOGLE_STORAGE_OAUTH_ENABLED=true`, login requests `openid email profile`
and the narrow Drive scopes together, then saves encrypted storage authority
before issuing the session. A storage-disabled IAM lab requests identity only.
If your API runs on a different
port (for example 3101), use that port in **both** registered callbacks. See
[ADR 0009](../architecture/adr-0009-shared-google-oauth-client.md) for migration
from the previous two-client configuration.

## Commands

```bash
pnpm infra:auth:up
pnpm infra:auth:verify
pnpm infra:authorization:up
pnpm infra:db:migrate
pnpm dev
pnpm infra:oidc:verify
```

`infra:auth:up` now starts only the shared PostgreSQL foundation. Google is a
hosted dependency and therefore has no local container to start.

## Logout behavior

Logout deletes the ZeroSheet session and returns to the application. It does
not attempt to sign the person out of Gmail, Drive, or every other Google
product. The next authorization request uses `prompt=select_account`, allowing
the person to choose a different Google account.

## Role boundary

Authentication and authorization remain separate:

```text
Google:  subject 109... authenticated
OpenFGA: user:<product UUID> is admin of organization:<UUID>
OpenFGA: user:<product UUID> is editor of workbook:<UUID>
OPA:     account and tenant status permit this request now
```

This separation is why removing Keycloak does not remove roles.
