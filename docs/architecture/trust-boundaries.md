# Initial trust boundaries

ZeroSheet separates authentication, authorization, product data, and encryption-key access.

```text
Browser
  -> Google / optional upstream authentication
  -> Keycloak broker / sole ZeroSheet OIDC issuer
  -> opaque HttpOnly ZeroSheet session
  -> Google Drive and Sheets APIs / short-lived delegated storage access
  -> ZeroSheet API / BFF / PEP
      -> Keycloak / authentication
      -> OpenFGA / relationship authorization
      -> OPA / contextual authorization
      -> PostgreSQL / product and session state
      -> local SPIRE Workload API / short-lived workload identity
      -> Google OAuth endpoints / code exchange, refresh, and revocation only
```

## Invariants

1. The browser cannot choose its acting user ID. The API derives it from a validated server session.
2. Identity establishes a principal; it does not grant workbook access by itself.
3. Application authorization is evaluated by the API through OpenFGA and OPA.
4. Google Drive permission, ZeroSheet permission, and possession of a decryption-key envelope are separate controls.
5. Passwords, OAuth tokens, private keys, recovery phrases, and plaintext protected cells must never enter logs.
6. Missing or unavailable authorization data results in denial.
7. Keycloak tokens and OIDC client secrets remain behind the BFF boundary; browser JavaScript receives only a narrow product-user projection.
8. External identities are keyed by the OIDC `(issuer, subject)` pair. Email alone never links accounts.
9. Upstream Google login and Google Drive API authorization are separate grants;
   sign-in does not grant storage access.
10. A Keycloak provider hint selects a reviewed login route but never bypasses
    first-login, account-linking, token validation, or product authorization.
11. Organization administration does not imply workbook plaintext access;
    workbook relationships are explicit and separately enforced.
12. OpenFGA stores product-user/resource relationships only. An authorization
    allow neither contains nor substitutes for a decryption-key envelope.
13. PostgreSQL commits pending product state and an exact relationship outbox
    intent together; only successful, idempotent OpenFGA application activates
    that state.
14. Organization-member removal also removes tenant team memberships so a
    leaver cannot retain a team-inherited workbook authorization path.
15. Existing-resource actions require both an OpenFGA relationship allow and
    an OPA contextual allow; either decision can deny but neither alone grants.
16. PostgreSQL is the PIP for current account/tenant status. Missing context,
    pending resource metadata, or an unavailable PDP fails closed.
17. OPA receives only minimized identifiers, lifecycle status, the fixed
    action/resource pair, and the OpenFGA result—never credentials or content.
18. SCIM provisioning credentials are tenant-bound and stored only as digests;
    they are not browser sessions and cannot authenticate product requests.
19. A tenant-scoped suspended lifecycle row denies access and revokes existing
    sessions before asynchronous relationship cleanup can succeed or fail.
20. Directory usernames or email addresses never link OIDC identities by
    themselves; authentication identity remains keyed by issuer and subject.
21. Audit export requires tenant administration, audit details exclude secrets
    and content, and ordinary application DML cannot rewrite recorded events.
22. Human OIDC sessions and SPIFFE workload SVIDs identify different kinds of
    principals and never substitute for each other.
23. The Workload API remains a local Unix socket; SVID private keys stay in
    process memory and are never committed, logged, or stored in PostgreSQL.
24. API and worker use distinct selector-bound SPIFFE IDs. An unregistered
    process receives no default workload identity.
25. Trusting a signed SVID still requires checking its exact peer SPIFFE ID;
    membership in the trust domain alone is not authorization.
26. Internal API-to-worker traffic uses TLS 1.3 with both peers presenting
    SPIRE-issued X.509-SVIDs; there is no plaintext or shared-secret fallback.
27. The worker verifies the exact API URI SAN, while the API verifies the chain
    and separately authorizes only the exact worker URI SAN for reconciliation.
28. SVID updates replace in-memory TLS contexts; invalid or expired credentials
    fail closed instead of being persisted for later reuse.
29. The workload-only listener is private and separate from human OIDC session
    endpoints. Neither principal type substitutes for the other.
30. Protected plaintext, recovery phrases, usable user private keys, and raw
    workbook keys exist only in the authorized browser. Google and ordinary
    ZeroSheet services receive ciphertext, public keys, encrypted private-key
    backups, recipient envelopes, and necessary metadata only.
31. The 12-word recovery phrase protects the user's encrypted HPKE private-key
    backup; it is not a global content key and is never stored by ZeroSheet.
32. Each workbook version uses a fresh random 256-bit key. That key is stored
    remotely only inside an HPKE envelope bound to the exact workbook, key
    version, recipient key version, and recipient public-key fingerprint.
33. Each protected cell uses a fresh AES-GCM nonce and authenticates its exact
    workbook, stable tab ID, coordinate, and workbook-key version as AAD.
34. A recovery phrase held in browser memory is bound to an immutable product
    user ID and is cleared on account change, explicit lock, and page reload;
    localStorage and sessionStorage are not recovery stores.
35. A public-key fingerprint is an identifier and corruption/pinning aid, not
    a secret, password, certificate authority, or proof of key ownership.
36. HPKE base mode provides recipient confidentiality but no sender signature;
    authenticated API actions and audit records separately identify the actor.
37. Cell authentication prevents cross-location swapping but does not prevent
    same-coordinate rollback. Production freshness needs an authenticated
    workbook revision or manifest in a later format.
38. Google sign-in and Google storage use separate OAuth clients, transactions,
    scopes, tokens, and revocation lifecycles. Neither grant substitutes for
    the other.
39. The BFF stores only an AES-256-GCM-encrypted Google refresh token and gives
    an authenticated exact-origin browser only a short-lived access token. The
    browser retains it in memory and sends it only to fixed Google API origins.
40. `drive.file` limits the adapter to app-created or explicitly selected files;
    `drive.appdata` contains only a phrase-encrypted private-key backup. Hidden
    app data is never treated as encryption.
41. Google receives unprotected cell values by product design. Only cells the
    user marks protected are guaranteed to reach Google as `zs1` ciphertext.
42. A live API compromise may use the encrypted refresh-token authority after
    accessing its deployment key, but that authority still cannot decrypt a
    protected cell without the user's HPKE private key and workbook envelope.
43. Univer is a local spreadsheet UI/engine. It receives plaintext only after
    browser-side decryption and receives no Google access token, recovery
    phrase, raw workbook-key bytes, or server-side encryption secret.
44. Selection protection is coordinate-exact. Unprotected values intentionally
    remain visible to Google, while protected blank cells still receive a `zs1`
    marker so their protection decision survives a reload.
45. A Google values write is one bounded `RAW` batch of at most 10,000 cells.
    ZeroSheet verifies the Drive file version before a write and serializes
    local saves, but Google provides no atomic version compare-and-swap for the
    Sheets values API, so a narrow check/write race remains.
46. The Milestone 12 preview key is temporary and never uploads data. A real
    workbook save must wait until an HPKE envelope for the creator's public key
    has been durably stored, preventing ciphertext from outliving its only key.
