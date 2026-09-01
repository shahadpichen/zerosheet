# Initial trust boundaries

ZeroSheet separates authentication, authorization, product data, and encryption-key access.

```text
Browser
  -> ZeroSheet API / PEP
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
