# ADR 0009: One Google client, purpose-specific OAuth flows

- Status: Accepted
- Date: 2026-09-26
- Amends: ADR 0003 and ADR 0008's client-registration choices
- Updated by: ADR 0010 (combined login/Drive onboarding)

## Why change it

ZeroSheet has one server-side web application. Separate sign-in and storage
client IDs made developers configure the same integration twice. Updating one
pair could leave login pointing at a deleted client while Drive used the new
one. A client identifies our application; scopes identify the permissions it
requests. Drive and Sheets do not require separate client registrations.

## Decision

Configure exactly one `GOOGLE_OAUTH_CLIENT_ID` and one
`GOOGLE_OAUTH_CLIENT_SECRET` (or `GOOGLE_OAUTH_CLIENT_SECRET_FILE` in production).
`RuntimeConfig.googleOAuthClient` owns this pair. The runtime passes that same
object to the OIDC and storage adapters; neither flow has credential settings
of its own. Production mounts one `google_oauth_client_secret` file.

With storage enabled, normal onboarding combines the permissions. A separate
reconnect route remains for an existing session with missing storage access:

| Purpose              | Requested scopes                                | Callback                   | Result                                                              |
| -------------------- | ----------------------------------------------- | -------------------------- | ------------------------------------------------------------------- |
| Continue with Google | `openid email profile drive.file drive.appdata` | `/auth/callback`           | Validated identity, encrypted storage authority, then local session |
| Reconnect Drive      | `drive.file drive.appdata`                      | `/google/storage/callback` | Repaired storage authority for an existing session                  |

Login and reconnect retain their own one-use state, PKCE verifier, transaction
cookie and callback. Reconnect requires an existing product session. Combined
login first validates the ID token/nonce, then saves storage before creating the
session. Storage tokens alone cannot create a login,
grant an OpenFGA role, or decrypt workbook ciphertext.

Storage-disabled IAM labs remain possible through `GOOGLE_STORAGE_OAUTH_ENABLED`;
those deployments request identity only. The
`GOOGLE_STORAGE_TOKEN_ENCRYPTION_KEY` remains separate: that key protects stored
refresh tokens, whereas the client secret authenticates ZeroSheet to Google.
`GOOGLE_OIDC_HOSTED_DOMAIN` remains a login-only restriction on verified identity.
These are different responsibilities, not duplicate credentials.

## Consent and revocation caveat

The storage request uses incremental authorization. Google may include earlier
identity scopes in the resulting token. We require both storage scopes, not an
exact two-scope response. Never describe this token as necessarily storage-only.

Google documents revocation at the project level, across its clients. Calling
revoke during Drive disconnect can therefore remove the user's other Google
grants to this project too. It does not itself delete their ZeroSheet account or
end the local session; subsequent sign-in may need consent again. Two clients
inside one project would not provide independent revocation boundaries either.

See [Google's incremental authorization and revocation documentation](https://developers.google.com/identity/protocols/oauth2/web-server#incrementalAuth).

## Existing installation migration

1. Choose the active Google **Web application** client and its matching secret.
   Do not mix a new secret with an old/deleted client ID.
2. Replace the retired `GOOGLE_OIDC_CLIENT_*` and
   `GOOGLE_STORAGE_OAUTH_CLIENT_*` entries with the single pair above. The config
   loader rejects retired entries, even if the new pair is also present, to
   catch stale environment overrides instead of silently ignoring edits.
3. For production, mount `google_oauth_client_secret` and update the client ID
   in the production environment file. Keep the refresh-token encryption key
   unchanged; changing it would make existing encrypted tokens unreadable.
4. Register both callbacks on that client using the actual public API base.
   Default development uses `http://localhost:3001`; an API running on `3101`
   needs both `http://localhost:3101/auth/callback` and
   `http://localhost:3101/google/storage/callback`. A production `/api` prefix
   must appear in both registered callbacks.
5. Restart the API to reload credentials and start a fresh login. Old browser
   authorization URLs still contain the old client ID.
6. A connection whose refresh token belongs to a replaced/deleted client must
   reconnect. Renaming environment variables cannot transfer that token to a
   different client. No migration deletes accounts, workbook data or keys.

Use distinct registrations for development and production, but only one client
pair per ZeroSheet deployment. Do not reuse a project that has unrelated broad
Google grants if you want this application's consent to stay narrow.

## Verification

Configuration tests cover disabled/enabled storage, single mounted-secret reads,
missing credentials and rejection of old names. Cross-flow tests use the real
OIDC URL builder with mocked discovery to verify a shared client ID, distinct
callbacks, PKCE and combined-login versus reconnect scopes. Existing service tests
continue to cover transaction/session binding and missing storage permissions.
Real Google consent and token exchange still require a manual account test.
