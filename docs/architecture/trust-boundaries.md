# Initial trust boundaries

ZeroSheet separates authentication, authorization, product data, and encryption-key access.

```text
Browser
  -> Google / optional upstream authentication
  -> Keycloak broker / sole ZeroSheet OIDC issuer
  -> opaque HttpOnly ZeroSheet session
  -> ZeroSheet API / BFF / PEP
      -> Keycloak / authentication
      -> OpenFGA / relationship authorization
      -> OPA / contextual authorization
      -> PostgreSQL / product and session state
      -> Google APIs / encrypted workbook storage
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
