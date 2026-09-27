# ADR 0003: Separate delegated Google storage authorization

- Status: Accepted
- Date: 2026-09-03
- Amended by: ADR 0009 (one client) and ADR 0010 (combined onboarding)

## Decision

Use the same Google OAuth web-server client as sign-in. With storage enabled,
request `drive.file` and `drive.appdata` alongside identity scopes at login.
Persist encrypted storage authority before issuing a session. An existing
session may use the reconnect flow, which requires that same product session
throughout its PKCE-bound callback.

The BFF encrypts the durable Google refresh token with an independent
AES-256-GCM deployment key before storing it in PostgreSQL. It returns only a
short-lived access token to the authenticated browser through an exact-origin,
`no-store` endpoint. The browser keeps that token in memory and calls fixed
Google Drive and Sheets API origins directly.

Google Sheets stores protected cells only after browser encryption. The
`appDataFolder` may contain the Capsule-encrypted user private-key backup; it
never contains the recovery phrase or an opened private key.

## Why

- Authentication and storage authority have different application purposes.
  Combined onboarding requires both; a storage-disabled IAM lab can still use
  identity-only login. Disconnect does not delete the product identity.
  Google consent/revocation is project-wide,
  however: disconnect can also revoke previously granted identity scopes.
  The existing ZeroSheet session remains local; future login may ask for consent.
- Direct browser-to-Google writes preserve the plaintext boundary: the VPS
  does not proxy decrypted cell values.
- `drive.file` limits the client to files it creates or the user explicitly
  opens/shares with the app instead of granting access to the whole Drive.
- `drive.appdata` gives one hidden application-data location for the already
  encrypted private-key backup. Hidden is not treated as encrypted.
- Server-held offline authority makes reconnect-free token refresh possible
  without placing a durable refresh token in browser storage.
- Fixed endpoints, bounded responses, one-use state, PKCE, exact callback URLs,
  and exact-origin token requests reduce credential exfiltration paths.

## Consequences

- A database dump alone cannot use the encrypted refresh token without the
  separately managed deployment key.
- A live compromised API process or administrator with both database and key
  access can obtain a Google access token. It can read app-created Drive files,
  including unprotected cells and protected-cell ciphertext, but it still lacks
  recovery phrases and workbook keys needed to decrypt protected cells.
- Browser XSS can steal the current short-lived access token and plaintext
  visible during that page lifetime. CSP and frontend supply-chain controls
  therefore remain essential.
- Google remains able to see metadata, unprotected values, ciphertext size and
  structure, and access timing.
- Google file permissions and ZeroSheet/OpenFGA permissions remain independent.
  Permission synchronization is a later milestone and must never create a key
  envelope merely because a Drive permission exists.
- Deployment-key rotation needs an explicit new token-envelope version and
  re-encryption procedure; silently replacing the key would strand connections.
