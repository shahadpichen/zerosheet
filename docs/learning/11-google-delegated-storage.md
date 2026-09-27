# Milestone 11: Delegated Google Drive and Sheets storage

## What this milestone teaches

ZeroSheet now has a Google storage boundary without confusing storage consent
with identity verification. One Google web client supports combined onboarding
and an exceptional reconnect path:

```text
Combined onboarding
Browser -> Google identity + storage consent -> /auth/callback
       -> verify identity -> save encrypted refresh token -> ZeroSheet session

Reconnect (existing session only)
Authenticated browser -> ZeroSheet BFF -> Google Drive/Sheets consent
Browser <- short-lived access token <- ZeroSheet BFF
Browser -> fixed Google Drive/Sheets APIs with encrypted protected cells
```

Combined onboarding uses the same verified Google account for identity and
storage. An explicit reconnect can choose a different storage account, but
cannot change the ZeroSheet product identity. See
[ADR 0010](../architecture/adr-0010-combined-google-onboarding.md) for the exact
callback ordering, failure handling and fresh-token consent tradeoff.

## Why an OAuth web-server flow is still needed

Google access tokens expire quickly. Requesting `access_type=offline` lets the
authorization-code exchange return a refresh token that can obtain future
access tokens without asking the user to consent on every page load.

The normal login saves its grant directly through the server-only storage
handoff before issuing the session. It needs no second browser redirect. The
repair/reconnect flow is:

1. The signed-in browser opens `/google/storage/connect`.
2. The BFF creates random `state`, a PKCE verifier/challenge, and a separate
   opaque HttpOnly transaction selector.
3. PostgreSQL stores the selector digest, user ID, state, verifier, and expiry.
4. Google requests consent for the two storage scopes, potentially alongside
   previously granted identity scopes through incremental authorization.
5. Google returns an authorization code and state to the fixed BFF callback.
6. The BFF requires the same product session, consumes the one-use transaction,
   validates state, and exchanges the code using the PKCE verifier and
   confidential client secret.
7. The service rejects partial scope consent, encrypts the refresh token, and
   stores the encrypted envelope.
8. The browser requests a short-lived access token from an exact same-origin
   POST endpoint. The response is `no-store` and memory-only.

`state` binds the callback to the started browser flow. The separate HttpOnly
selector makes a stolen state value insufficient. PKCE makes a stolen
authorization code insufficient without the verifier. The authenticated
product session binds all of it to the stable user chosen by server-side
session lookup, never a user ID supplied by browser JSON.

## The two scopes

`https://www.googleapis.com/auth/drive.file` lets the app use files it creates
or files a user explicitly selects/shares with it. It is a Google-designated
non-sensitive scope and is sufficient for both Drive file operations and the
Sheets values API on those files.

`https://www.googleapis.com/auth/drive.appdata` allows access only to the app's
hidden `appDataFolder`. ZeroSheet uses it for the Capsule-encrypted private-key
backup. The folder being hidden is convenience, not confidentiality: the
backup remains safe because the 12-word phrase is required to open it.

The storage adapter does not explicitly request broad `drive`, identity
(`openid`, `email`, `profile`), Gmail, directory, or administrator scopes.
Because incremental authorization includes earlier grants, the returned token
may also carry identity scopes. The service checks that both storage scopes
exist rather than rejecting a valid combined grant. Use a dedicated ZeroSheet
Google Cloud project without unrelated broad grants.

Disconnect removes the local stored connection and attempts Google revocation.
Google revokes grants at the project level, so this can also revoke identity
consent. It does not delete the ZeroSheet account or end the local session;
Google may ask for consent at the next login. Separate clients inside the same
project would not isolate this revocation behavior.

## Where each credential lives

| Value                        | Location                                                | Lifetime and meaning                                                                              |
| ---------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| ZeroSheet session selector   | HttpOnly browser cookie; digest in PostgreSQL           | Identifies the signed-in ZeroSheet session.                                                       |
| Google client secret         | One shared BFF deployment secret                        | Authenticates the same client for login and storage; never sent to browser code.                  |
| Google refresh token         | AES-256-GCM envelope in PostgreSQL                      | Durable authority to request short access tokens.                                                 |
| Refresh-token encryption key | deployment secret outside PostgreSQL                    | Independent 32-byte key; not a recovery phrase or workbook key.                                   |
| Google access token          | BFF memory and browser module memory                    | Short-lived authority for granted scopes, including earlier consent; never local/session storage. |
| Recovery phrase              | user memory/offline record and temporary browser memory | Opens the encrypted HPKE private-key backup; Google and BFF never receive it.                     |
| Workbook key                 | authorized browser memory; remote HPKE envelopes only   | Decrypts protected cells; unrelated to every OAuth credential above.                              |

Encrypting a refresh token is not magic protection from the running service.
A database thief without the deployment key gets ciphertext. A live malicious
server with the key can decrypt the token and operate within the narrow Google
scopes. It still cannot decrypt protected cells because OAuth authority is not
an HPKE private key or workbook key.

## Browser storage adapter

`@zerosheet/google-storage` accepts already encrypted values and exposes a
small reviewed operation set:

- create/read an app-owned Google spreadsheet;
- batch-read values using formula-preserving representations;
- batch-write values with `RAW` semantics so `zs1` strings are never evaluated
  as formulas;
- batch-clear ranges; and
- put/get a size-bounded encrypted private-key backup in `appDataFolder`.

Callers choose `drive` or `sheets` plus a relative path. The request layer maps
those choices to fixed `googleapis.com` origins, so a future UI bug cannot pass
an arbitrary URL and attach the bearer token to it. Inputs, ranges, batch sizes,
resource IDs, response sizes, and provider response shapes are bounded and
validated. Provider error bodies are not copied into product errors or logs.

Protected cells reach this adapter as `zs1` ciphertext. Unprotected cells are
ordinary values and are visible to Google. That is the product's selective
encryption promise; it is not full-sheet secrecy.

## PostgreSQL records

Migration `005_google_storage_oauth.sql` creates:

- `google_storage_oauth_transactions`, containing one-use, expiring PKCE flow
  state bound to a product user; and
- `google_storage_connections`, containing one encrypted refresh-token
  envelope, exact granted scopes, and timestamps per product user.

There is intentionally no plaintext `refresh_token` column. The repository
interface itself only accepts `encryptedRefreshToken`, making an accidental
plaintext write more difficult during future refactoring.

## Google Cloud setup

Interactive Google testing requires manual project-owner configuration:

1. Create or select a development Google Cloud project.
2. Enable **Google Drive API** and **Google Sheets API**.
3. Configure the Google Auth Platform branding/audience and add development
   test users when the app is in testing mode.
4. Use the same **Web application** OAuth client as ZeroSheet sign-in. One
   client handles both Drive and Sheets APIs too.
5. Register both exact local authorized redirect URIs on that client:

   ```text
   http://localhost:3001/auth/callback
   http://localhost:3001/google/storage/callback
   ```

   If the API runs on another port, replace 3001 in both URLs with that port.

6. Set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` once in the
   ignored `.env`. Generate a random 32-byte base64url token-encryption key
   (`GOOGLE_STORAGE_TOKEN_ENCRYPTION_KEY`), and set
   `GOOGLE_STORAGE_OAUTH_ENABLED=true`.
7. Apply migrations, start the API/web app, and choose **Continue with Google**.
   Allow identity and storage permissions together. The first authenticated
   page opens directly without a separate Drive panel or second connect step.
   For diagnostics, the authenticated `/google/storage/status` endpoint reports
   the stored grant. The [workbook UI](15-workbook-browser.md) opens saved files.

Production registers both exact public HTTPS API callbacks and keeps the client secret
and token-encryption key in separately backed-up secret files. Losing the token
key makes stored refresh-token envelopes unusable; leaking it together with the
database exposes the Google storage grants.

Generate a key without printing it into shell history where practical. One
development option is `openssl rand -base64 32` followed by base64url conversion;
store the result directly in the ignored secret file, never in Git or chat.

## Verification

```bash
pnpm infra:google-storage:verify
pnpm typecheck
pnpm test
pnpm lint
pnpm format:check
pnpm build
```

The focused verifier uses no real Google credential. It tests the fixed OAuth
gateway, state/PKCE service, encrypted refresh-token envelope, HTTP route
boundary, browser adapter, and live PostgreSQL schema. Real consent remains an
explicit manual test because automating a personal Google login would require
handling user credentials and defeat the lesson.

## Official references

- [Google OAuth 2.0 for web server applications](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Google Drive API scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [Google Sheets API scopes](https://developers.google.com/workspace/sheets/api/scopes)
- [Sheets values batchUpdate](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/batchUpdate)
- [Drive permissions.create](https://developers.google.com/workspace/drive/api/reference/rest/v3/permissions/create)
