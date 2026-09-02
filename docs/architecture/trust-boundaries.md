# Initial trust boundaries

ZeroSheet separates authentication, authorization, product data, and encryption-key access.

```text
Browser
  -> opaque HttpOnly ZeroSheet session
  -> ZeroSheet API / BFF / future PEP
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
