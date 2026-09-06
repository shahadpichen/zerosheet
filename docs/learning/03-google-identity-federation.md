# Milestone 3: Google identity federation through Keycloak

## Learning objective

Understand enterprise identity brokering: Google authenticates a person,
Keycloak turns that upstream result into a ZeroSheet-realm identity, and
ZeroSheet continues to trust exactly one OIDC issuer.

## The completed trust chain

```text
Browser
  -> GET /api/auth/login/google
  -> ZeroSheet creates state, nonce, PKCE, and a one-time transaction
  -> ZeroSheet redirects to its trusted Keycloak realm with kc_idp_hint=google
  -> Keycloak redirects to Google's authorization endpoint
  -> Google authenticates the person and returns to Keycloak's broker callback
  -> Keycloak runs its first-broker-login and account-linking protections
  -> Keycloak issues its own authorization code to ZeroSheet's callback
  -> ZeroSheet validates the Keycloak issuer and creates an opaque product session
```

There are two OAuth/OIDC relationships in this chain:

1. Keycloak is an OAuth client of Google.
2. The ZeroSheet API/BFF is an OIDC client of Keycloak.

ZeroSheet is not a Google OAuth client for sign-in and never validates a Google
ID token. This separation is valuable in an enterprise product because adding a
future SAML customer, another OIDC provider, or a local MFA policy changes
Keycloak configuration without creating another authentication implementation
inside every ZeroSheet service.

## Why `kc_idp_hint` is not a trust bypass

The **Continue with Google** button uses a fixed application route. That route
adds `kc_idp_hint=google` to the normal Keycloak authorization request. The hint
only lets Keycloak skip its provider chooser and start at Google.

It does not bypass:

- the ZeroSheet login transaction, state, nonce, or PKCE verification;
- Google's authentication;
- Keycloak's Google broker callback;
- Keycloak's first-broker-login and account-linking flow;
- Keycloak's own code and token issuance; or
- ZeroSheet's `(Keycloak issuer, Keycloak subject)` identity mapping.

The API does not accept an arbitrary provider alias from a query parameter. Each
permitted upstream provider gets an explicit reviewed route.

## Identity keys at each layer

Google has a subject for the user within the Google OAuth client. Keycloak
stores that value in its federated-identity link and assigns the user a Keycloak
subject. ZeroSheet then maps this stable pair:

```text
(http://localhost:8080/realms/zerosheet, Keycloak subject)
```

to a ZeroSheet `product_users.id`. Email and display name are profile data. They
can change and are not used as the permanent product identity key.

## First login and safe account linking

The provider uses Keycloak's built-in `first broker login` flow. If Google
returns an email that already belongs to a local Keycloak account, matching the
text of the email is not sufficient proof that both identities belong to the
same person. Keycloak requires the user to confirm and authenticate the existing
account before linking it.

This prevents an attacker from creating an upstream identity with a matching or
misverified email and silently taking over an existing account. A later
enterprise milestone can customize this flow, but must preserve proof of both
identities before linking.

`trustEmail=true` tells Keycloak it may accept Google's verified-email result
during brokering. It does not tell ZeroSheet to link product users by email.

## Minimal scopes and token storage

The Google sign-in provider asks for only:

```text
openid profile email
```

`storeToken=false` means Keycloak does not retain Google's access or refresh
token for later API calls. Sign-in proves identity; it does not give ZeroSheet
permission to read or modify Google Drive.

The future Drive connection is a separate OAuth grant with Drive-specific
scopes, consent, encrypted token storage, revocation, and synchronization rules.
Keeping these grants separate lets a user sign in with Google without granting
Drive access, or revoke Drive access without deleting their ZeroSheet identity.

## Hosted-domain setting

`GOOGLE_OIDC_HOSTED_DOMAIN` can give Google's account chooser a Workspace-domain
hint. It is a convenience, not an authorization rule. Organization membership
and workbook access must be checked from ZeroSheet's own organization state and
future OpenFGA/OPA decisions.

## Local setup in Google Cloud

Google Cloud Console setup is the one manual part because only the project owner
can create and consent to an OAuth client:

1. Create or choose a Google Cloud project. Prefer a separate development
   project so test credentials and users cannot affect production.
2. Configure the Google Auth Platform branding and audience. For local work,
   use a testing audience and add the Google accounts that may test login.
3. Create an OAuth client with application type **Web application**.
4. Add this exact **Authorized redirect URI**:

   ```text
   http://localhost:8080/realms/zerosheet/broker/google/endpoint
   ```

   This is Keycloak's broker callback, not ZeroSheet's `/auth/callback`.
   Google returns to Keycloak first; Keycloak later returns to ZeroSheet.

5. Put the client ID and secret in the ignored `.env` file:

   ```dotenv
   GOOGLE_OIDC_CLIENT_ID=your-client-id.apps.googleusercontent.com
   GOOGLE_OIDC_CLIENT_SECRET=your-client-secret
   GOOGLE_IDENTITY_PROVIDER_ENABLED=true
   GOOGLE_OIDC_HOSTED_DOMAIN=
   ```

6. Apply and verify the provider:

   ```bash
   pnpm infra:auth:up
   pnpm infra:federation:google:verify
   ```

7. Run `pnpm dev`, open `http://localhost:5173`, and choose **Continue with
   Google**.

Google permits loopback HTTP redirect URIs for local development. Production
must use the exact public HTTPS Keycloak broker callback and separate production
credentials.

## Why provisioning is an explicit command

Keycloak imports `zerosheet-realm.json` when a realm is first created, but it
does not overwrite an existing realm on every container restart. That behavior
protects users and administrator changes. Therefore:

- the realm file documents a disabled Google provider for fresh installations;
- `pnpm infra:federation:google:configure` creates or updates the provider using
  Keycloak's supported Admin REST API;
- the command can be run repeatedly without creating duplicate providers;
- placeholder credentials are allowed only while the provider is disabled; and
- passwords, client secrets, and administrator tokens are never printed.

`pnpm infra:federation:google:verify` applies the configuration and then reads
back Keycloak's persisted policy. `pnpm infra:oidc:verify`, while the API is
running, also proves the Google route keeps the protected transaction and adds
only the reviewed broker hint.

## Security invariants

1. ZeroSheet trusts Keycloak's issuer, never a browser-supplied Google identity.
2. The Google client secret is available to Keycloak provisioning, not browser
   code.
3. A disabled placeholder configuration cannot accidentally be enabled.
4. Google login requests only identity scopes and stores no upstream token.
5. Existing accounts are not silently linked by matching email alone.
6. A hosted-domain hint does not grant organization or workbook access.
7. Google login uses the same state, nonce, PKCE, callback, and opaque session as
   local Keycloak login.
8. Google Drive access remains a separate, explicit authorization grant.

## Deliberately deferred

- Creating the real Google Cloud OAuth client, because it requires the project
  owner's Google account and consent-screen decisions.
- Organization-specific provider routing and customer-owned OIDC/SAML IdPs.
- MFA, step-up authentication, and organization authentication policies.
- Linking and unlinking identities from a signed-in account-management page.
- Google Drive scopes, refresh-token storage, revocation, and synchronization.
- OpenFGA relationship authorization and OPA contextual policy.

## Primary references

- [Keycloak identity brokering](https://www.keycloak.org/docs/latest/server_admin/#_identity_broker)
- [Keycloak Google identity provider](https://www.keycloak.org/docs/latest/server_admin/#google)
- [Keycloak Admin REST API](https://www.keycloak.org/docs-api/latest/rest-api/index.html)
- [Google OAuth 2.0 for web server applications](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Google OAuth audience and test users](https://support.google.com/cloud/answer/15549945)

## Completion criteria

- A fresh realm contains one disabled Google provider template.
- Existing realms can create or update the provider idempotently.
- Enabling placeholder credentials fails before Keycloak is changed.
- Persisted provider settings pass the automated security-policy verifier.
- `/auth/login/google` redirects to Keycloak with `kc_idp_hint=google`.
- The Google shortcut retains the normal protected login transaction cookie.
- The web screen presents Google and local Keycloak login choices.
- Automated unit, type, lint, format, build, infrastructure, and live OIDC checks
  pass.
