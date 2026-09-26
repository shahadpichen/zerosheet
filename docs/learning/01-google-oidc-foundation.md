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

The browser never receives Google's client secret, access token, or ID token.
After the callback, it receives only an HttpOnly ZeroSheet session cookie.

## Local Google Cloud setup

Create a **Web application** OAuth client for authentication and register this
exact redirect URI:

```text
http://localhost:3001/auth/callback
```

Put its client ID and secret in the ignored `.env` file:

```dotenv
GOOGLE_OIDC_CLIENT_ID=...
GOOGLE_OIDC_CLIENT_SECRET=...
GOOGLE_OIDC_HOSTED_DOMAIN=
```

Leave the hosted domain empty for consumer and Workspace accounts. If it is
set, ZeroSheet sends it as an account-selection hint and independently requires
the matching signed `hd` claim before creating a session.

The separate Drive/Sheets OAuth client still uses:

```text
http://localhost:3001/google/storage/callback
```

Do not combine the sign-in and storage clients. Authentication requests only
`openid email profile`; Drive access is a later, separate consent ceremony.

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
