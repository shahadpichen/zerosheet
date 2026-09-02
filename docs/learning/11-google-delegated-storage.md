# Milestone 11: Delegated Google Drive and Sheets storage

## What this milestone teaches

ZeroSheet now has a Google storage boundary without confusing storage consent
with login. There are two deliberately separate Google relationships:

```text
Sign-in
Browser -> Keycloak -> Google identity scopes -> Keycloak -> ZeroSheet session

Storage
Authenticated browser -> ZeroSheet BFF -> Google Drive/Sheets consent
Browser <- short-lived access token <- ZeroSheet BFF
Browser -> fixed Google Drive/Sheets APIs with encrypted protected cells
```

In the first flow, Google is Keycloak's upstream identity provider and Keycloak
is ZeroSheet's only OIDC issuer. In the second flow, ZeroSheet is Google's OAuth
client and the grant authorizes API operations. A Google account chosen for
storage may even differ from the account used to sign in; that changes storage
authority, not the ZeroSheet product-user identity.

## Why an OAuth web-server flow is still needed

Google access tokens expire quickly. Requesting `access_type=offline` lets the
authorization-code exchange return a refresh token that can obtain future
access tokens without asking the user to consent on every page load.

The flow is:

1. The signed-in browser opens `/google/storage/connect`.
2. The BFF creates random `state`, a PKCE verifier/challenge, and a separate
   opaque HttpOnly transaction selector.
3. PostgreSQL stores the selector digest, user ID, state, verifier, and expiry.
4. Google shows consent for exactly the two storage scopes.
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

The adapter does not request broad `drive`, identity (`openid`, `email`,
`profile`), Gmail, directory, or administrator scopes.

## Where each credential lives

| Value                        | Location                                                | Lifetime and meaning                                                             |
| ---------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Keycloak session selector    | HttpOnly browser cookie; digest in PostgreSQL           | Identifies the signed-in ZeroSheet session.                                      |
| Google client secret         | BFF deployment secret                                   | Authenticates the confidential OAuth client; never sent to browser code.         |
| Google refresh token         | AES-256-GCM envelope in PostgreSQL                      | Durable authority to request short access tokens.                                |
| Refresh-token encryption key | deployment secret outside PostgreSQL                    | Independent 32-byte key; not a recovery phrase or workbook key.                  |
| Google access token          | BFF memory and browser module memory                    | Short-lived authority for the two consented scopes; never local/session storage. |
| Recovery phrase              | user memory/offline record and temporary browser memory | Opens the encrypted HPKE private-key backup; Google and BFF never receive it.    |
| Workbook key                 | authorized browser memory; remote HPKE envelopes only   | Decrypts protected cells; unrelated to every OAuth credential above.             |

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
4. Create a **Web application** OAuth client dedicated to ZeroSheet storage.
   Do not reuse the Keycloak Google-login client.
5. Add this exact local authorized redirect URI:

   ```text
   http://127.0.0.1:3001/google/storage/callback
   ```

6. Put its client ID and secret in the ignored `.env`, generate a random
   32-byte base64url token-encryption key, and set
   `GOOGLE_STORAGE_OAUTH_ENABLED=true`.
7. Apply migrations, start the API/web app, sign in, and choose **Connect Google
   Drive**.

Production uses the exact public HTTPS API callback and keeps the client secret
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
