# Milestone 2: OIDC browser-facing backend authentication

## Learning objective

Understand how ZeroSheet delegates authentication to Keycloak without giving
the browser identity-provider tokens or trusting a user ID supplied by a client.

## Completed request flow

```text
Browser
  -> GET /api/auth/login
  -> ZeroSheet creates state, nonce, PKCE verifier, and transaction cookie
  -> ZeroSheet stores the cookie digest and short-lived PKCE transaction
  -> Browser redirects to Keycloak
  -> Keycloak authenticates the person
  -> Keycloak returns an authorization code to /auth/callback
  -> ZeroSheet atomically consumes the transaction
  -> ZeroSheet exchanges code + PKCE verifier using its client secret
  -> openid-client validates issuer, audience, signature, state, and nonce
  -> ZeroSheet maps (issuer, subject) to a product user
  -> ZeroSheet stores a session-token digest
  -> Browser receives the raw session only as an HttpOnly cookie
```

## The three correlated random values

- **State** binds the authorization response to the login transaction and
  protects the callback from login CSRF and response substitution.
- **Nonce** is sent through Keycloak and must appear in the signed ID token. It
  prevents a valid token from a different authentication event being replayed.
- **PKCE verifier** remains at ZeroSheet while its SHA-256 challenge goes to
  Keycloak. A stolen authorization code cannot be redeemed without the verifier.

These values solve different problems. Enabling PKCE does not make state or
nonce unnecessary for this OIDC BFF flow.

## Why the browser receives an opaque session

An access token is a bearer credential for APIs. Putting it in JavaScript or
browser storage increases the damage of cross-site scripting and makes logout,
rotation, and policy changes harder to control. ZeroSheet instead returns a
random session cookie with these attributes:

- `HttpOnly`: browser JavaScript cannot read it.
- `SameSite=Lax`: normal top-level login redirects work while most cross-site
  subrequests do not carry the cookie.
- `Secure` in production: the browser sends it only over HTTPS.
- `__Host-` prefix in production: no Domain attribute, Path `/`, and Secure are
  enforced by supporting browsers.
- Absolute eight-hour expiry for this milestone.

The cookie is not signed because its random value has no client-readable
meaning. PostgreSQL stores only its SHA-256 digest, and a modified value simply
does not select a session.

## Database ownership

The `zerosheet_app` role owns four new tables:

- `product_users`: stable application users independent of Keycloak IDs.
- `external_identities`: unique `(issuer, subject)` mappings to product users.
- `oidc_login_transactions`: one-use state, nonce, and PKCE data with ten-minute
  expiry; the raw selector cookie is not stored.
- `user_sessions`: absolute-expiry product sessions; the raw session cookie is
  not stored.

Email is profile data, not an identity key. Two providers returning the same
email are never linked automatically. Explicit authenticated linking requires a
later account-governance flow.

## Token handling

Keycloak returns an access token and ID token during the server-to-server code
exchange. `openid-client` verifies the ID token and ZeroSheet extracts only the
stable subject and basic profile. This milestone has no Keycloak-protected API
to call, so the tokens are discarded rather than stored without a purpose.

Google Drive authorization will later use a separate connection and encrypted
token-storage design. Google login and permission to operate on Google Drive are
related user experiences but separate OAuth grants and trust decisions.

## Local HTTP exception

OIDC libraries correctly require HTTPS. The local Keycloak laboratory uses HTTP
only on `localhost`, so the API enables `allowInsecureRequests` only when all of
the following are true:

1. The process is not in production.
2. The issuer scheme is HTTP.
3. The issuer hostname is `localhost`, `127.0.0.1`, or IPv6 loopback.

Any non-loopback HTTP issuer fails startup. Production also refuses insecure
cookies and requires HTTPS deployment configuration.

## Commands

```bash
pnpm infra:auth:up
pnpm infra:db:migrate
pnpm dev
pnpm infra:oidc:verify
```

Open `http://localhost:5173`, choose **Continue to Keycloak**, and sign in with
the local learner account. Its first password is temporary, so Keycloak asks the
user to replace it before returning to ZeroSheet.

## Security invariants

1. The browser cannot choose its ZeroSheet user ID.
2. Only the configured Keycloak issuer is trusted.
3. Every callback requires the matching browser transaction, state, nonce, and
   PKCE verifier.
4. A login transaction can be consumed once.
5. Raw transaction and session cookie values are never stored in PostgreSQL.
6. Callback query strings are not written to API request logs.
7. Missing, expired, or invalid session state returns HTTP 401.
8. Authentication creates a principal but grants no workbook permission.

## Deliberately deferred

- Google identity brokering and enterprise SAML/OIDC federation.
- MFA and organization-specific authentication policy.
- Idle session expiry, concurrent-session controls, and administrator revocation.
- Keycloak back-channel logout notifications that revoke matching product
  sessions when an administrator or upstream provider ends SSO centrally.
- OpenFGA relationship authorization and OPA contextual policy.
- Google Drive authorization and encrypted token storage.
- Workbook key creation, HPKE envelopes, and encrypted cell data.

## Primary references

- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html)
- [RFC 7636: Proof Key for Code Exchange](https://www.rfc-editor.org/rfc/rfc7636)
- [OAuth 2.0 Security Best Current Practice](https://www.rfc-editor.org/rfc/rfc9700)
- [openid-client API](https://github.com/panva/openid-client/tree/main/docs)

## Completion criteria

- Database migration runs as `zerosheet_app` and records its version.
- API startup fails when the database schema or OIDC issuer is unavailable.
- Login emits Authorization Code parameters, state, nonce, and PKCE S256.
- Callback state is bound to a hashed one-time browser transaction.
- Verified `(issuer, subject)` creates or updates one product user.
- Browser receives only an opaque HttpOnly product session.
- `/auth/me` returns HTTP 401 without a valid session and a narrow user object
  with a valid session.
- Logout deletes the product session and redirects through Keycloak logout.
