# ADR 0010: Sign in and connect Drive in one Google flow

- Status: Accepted
- Date: 2026-09-26
- Updates: ADRs 0003, 0008 and 0009

## User experience

Choose **Continue with Google**, review the explanation, and authorize identity
and storage together. On success the user enters the spreadsheet page directly.
There is no separate Drive status, connect, or disconnect panel, and opening the
workspace does not make a redundant storage-status request. The server retains
its authenticated status/reconnect endpoints for diagnostics and repair, but
they are not another onboarding step.

The workbook browser now leads to a dedicated saved editor. Permission failures
offer recovery at the failed operation instead of restoring a permanent
connection panel. See [the workbook UI notes](../learning/15-workbook-browser.md)
for its bounded editing scope and tests.

## Server sequence and why it matters

1. `/auth/login/google` creates one random state/nonce/PKCE transaction.
2. The request includes `openid email profile`, `drive.file`, `drive.appdata`,
   `access_type=offline` and `prompt=select_account consent`.
3. `/auth/callback` consumes that transaction and exchanges the code once.
   `openid-client` continues to enforce OIDC protocol checks; the application
   requires a verified email and any configured Workspace domain.
4. The gateway returns a narrow identity object and a **separate server-only**
   storage grant. Tokens are never properties of the product-user record.
5. The validated `(issuer, subject)` selects the product UUID. There is no
   browser-supplied acting user ID or email-based account merging.
6. `GoogleStorageService.connectFromLogin` requires both storage permissions,
   usable access-token expiry, and a fresh refresh token. It seals the refresh
   token using the existing user-bound AES-GCM envelope and saves it in PostgreSQL.
7. Only after storage succeeds does AuthService create a new opaque session.
   The callback sends a cookie and a frontend redirect, never Google tokens.

These are ordered operations, not one database transaction spanning Google.
An interrupted login can leave a product identity or encrypted connection saved
without a session. A new login safely retries setup. No raw refresh token is
ever persisted, and partial storage consent never produces a new connected
session. Existing sessions are not forcibly logged out if a new attempt fails.

## Consent and retries

Google may omit refresh tokens for previously authorized users. This version
explicitly asks for consent on login to obtain fresh authority from the same
exchange, even after a client migration or an older separately connected Drive
account. It deliberately does **not** silently reuse an old refresh token whose
Google account might differ. The tradeoff is a Google consent screen on later
logins too. A future returning-user optimization needs verified account binding
and safe refresh-token reuse, not simply removing `prompt=consent`.

If a permission is declined, a refresh token is missing, or storage persistence
fails, no new session is issued. The browser returns to a fixed retry notice.
Provider codes, state, token values and arbitrary error text never enter that
redirect. Invalid OIDC/state/nonce callbacks retain the existing generic error.
As allowed by OAuth, an omitted scope field means unchanged requested scopes;
an explicitly partial scope list always causes setup to fail.

## Configuration and what stays separate

No extra Google client, credential pair, feature flag or database is needed.
`GOOGLE_STORAGE_OAUTH_ENABLED=true` derives `connectStorageOnLogin` and wires the
storage handoff. `false` deliberately preserves an identity-only IAM lab; it
does not promise connected storage. The deployed product should enable it.

Keep both exact callback URLs registered on the shared client. Normal onboarding
uses `/auth/callback`; `/google/storage/callback` is now only for reconnect.
Enable Drive and Sheets APIs on the Google Cloud project. Update consent-screen
scopes/test users if necessary. Existing encryption keys, encrypted data, roles,
Google clients and secrets do not need replacement for this change.

Permissions and encryption remain distinct: signing in with Drive consent does
not grant organization roles or disclose recovery phrases/workbook keys.
Google revocation remains project-wide as explained in ADR 0009.

## Verification

Tests cover combined requested scopes, one code exchange, retained PKCE/state/
nonce checks, identity validation, encrypted token persistence before session
creation, missing refresh tokens, partial consent, storage failure, callback
replay, a safe retry redirect, and the storage-disabled mode. Live verification
checks the authorization URL but deliberately stops before personal consent.
Manual acceptance: log out of an existing session, continue with Google, grant
the requested permissions, and confirm the workspace opens without another
connection prompt. The authenticated `/google/storage/status` endpoint can
verify the stored grant; it accepts both URL-shaped Drive scopes and identity
scope tokens such as `openid`. This confirms the grant was stored, not that the
editor has uploaded a workbook or that Google access cannot be revoked.

Reference: [Google's web-server OAuth flow](https://developers.google.com/identity/protocols/oauth2/web-server).
