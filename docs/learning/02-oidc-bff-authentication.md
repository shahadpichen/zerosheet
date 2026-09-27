# Milestone 2: OIDC browser-facing backend authentication

## Learning objective

Understand how ZeroSheet delegates authentication to Google without giving
the browser identity-provider tokens or trusting a user ID supplied by a client.

## Completed request flow

```text
Browser
  -> GET /api/auth/login
  -> ZeroSheet creates state, nonce, PKCE verifier, and transaction cookie
  -> ZeroSheet stores the cookie digest and short-lived PKCE transaction
  -> Browser redirects to Google
  -> Google authenticates the person
  -> Google returns an authorization code to /auth/callback
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
- **Nonce** is sent through Google and must appear in the signed ID token. It
  prevents a valid token from a different authentication event being replayed.
- **PKCE verifier** remains at ZeroSheet while its SHA-256 challenge goes to
  Google. A stolen authorization code cannot be redeemed without the verifier.

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

- `product_users`: stable application users independent of Google IDs.
- `external_identities`: unique `(issuer, subject)` mappings to product users.
- `oidc_login_transactions`: one-use state, nonce, and PKCE data with ten-minute
  expiry; the raw selector cookie is not stored.
- `user_sessions`: absolute-expiry product sessions; the raw session cookie is
  not stored.

Email is profile data, not an identity key. Two providers returning the same
email are never linked automatically. Explicit authenticated linking requires a
later account-governance flow.

## Token handling

Google returns an access token and ID token during the server-to-server code
exchange. `openid-client` verifies the ID token and ZeroSheet extracts only the
stable subject and basic profile. In a storage-disabled lab, tokens are discarded.
With storage enabled, that same exchange also supplies the Drive grant. The
storage service encrypts the refresh token and caches the short-lived access
token before a product session is created. Neither is spread into the identity
record or login response. See ADR 0010 for the combined onboarding sequence.
Identity and file permissions remain different checks, even within one flow.

## Fixed HTTPS issuer

The API hard-codes Google's official HTTPS issuer for discovery instead of
accepting an environment-selected authority. Local development still uses an
HTTP callback on `localhost`, which Google permits for registered development
web clients; provider discovery, authorization, token exchange, and signing
keys always use HTTPS.

## Commands

```bash
pnpm infra:auth:up
pnpm infra:db:migrate
pnpm dev
pnpm infra:oidc:verify
```

Open `http://localhost:5173`, choose **Continue with Google**, and select a
Google account. Google owns the authentication ceremony; ZeroSheet never sees
the account password.

## Security invariants

1. The browser cannot choose its ZeroSheet user ID.
2. Only Google's fixed OIDC issuer is trusted.
3. Every callback requires the matching browser transaction, state, nonce, and
   PKCE verifier.
4. A login transaction can be consumed once.
5. Raw transaction and session cookie values are never stored in PostgreSQL.
6. Callback query strings are not written to API request logs.
7. Missing, expired, or invalid session state returns HTTP 401.
8. Authentication creates a principal but grants no workbook permission.

## Deliberately deferred

- Enterprise SAML/OIDC federation beyond Google.
- MFA and organization-specific authentication policy.
- Idle session expiry, concurrent-session controls, and administrator revocation.
- Provider event notifications that revoke matching product sessions centrally.
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
- API startup fails when the database schema or Google discovery is unavailable.
- Login emits Authorization Code parameters, state, nonce, and PKCE S256.
- Callback state is bound to a hashed one-time browser transaction.
- Verified `(issuer, subject)` creates or updates one product user.
- Browser receives only an opaque HttpOnly product session.
- `/auth/me` returns HTTP 401 without a valid session and a narrow user object
  with a valid session.
- Logout deletes only the product session and returns to ZeroSheet.
