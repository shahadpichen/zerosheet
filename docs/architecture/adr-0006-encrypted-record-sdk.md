# ADR 0006: Map bounded encrypted records onto fixed Google Sheet tabs

- Status: accepted
- Date: 2026-09-03

## Context

Application developers need a small record API without pretending Google
Sheets is PostgreSQL. The storage provider exposes rectangular values, coarse
file versions, and no atomic compare-and-swap transaction. Protected values
must still use the same authenticated `zs1` format as the interactive editor,
and the SDK must not create a second cryptographic protocol.

## Decision

`@zerosheet/sdk` maps one explicitly configured collection to one existing
Google Sheet tab. Row zero is a fixed public header. Column zero is a stable,
public `_id`; every configured business field is protected by default and must
be explicitly marked `public` to remain plaintext. Each protected cell reuses
the sheet-core AEAD codec with workbook ID, stable numeric sheet ID, title,
coordinate, value kind, formula marker, and key version bound as AAD.

The first SDK surface is deliberately bounded:

- `insert`, `get`, `update`, `delete`, and `all`;
- local `filter` and offset/limit `page` after decryption;
- explicit `exportPlaintext` naming the confidentiality transition;
- at most 10,000 records, 99 fields, 100 read ranges, and 10,000 cells per
  Google request;
- one in-process mutation queue and a Drive version check before writes.

Deleting clears a row instead of shifting later records because ciphertext is
authenticated to its row coordinate. Inserts reuse cleared rows. Header or
protection mismatches fail closed as schema/corruption errors. The application
must provide a recovered, non-extractable AES-GCM `CryptoKey` and the reviewed
Google storage adapter; the SDK never accepts a recovery phrase or raw key.

## Consequences

- The editor, SDK, and examples have one persistent encrypted-cell format.
- Public IDs and schema leak structure to Google by design; protected business
  values remain ciphertext.
- `get(id)` scans the bounded collection locally because there is no trusted
  searchable protected index yet.
- Local filtering downloads/decrypts the bounded collection and is not a
  server query plan.
- A Google version check narrows conflicts but cannot create an atomic Sheets
  compare-and-swap. Multi-writer correctness remains an explicit limit.
- Changing fields, sheet identity, or protection policy is a migration, not a
  casual constructor edit.

## Alternatives rejected

### Encrypt a whole JSON database into one cell

Small edits would rewrite one large blob, eliminate useful row visibility, and
amplify conflicts. It would also abandon the existing per-cell format.

### Let callers choose encryption algorithms per field

Algorithm choice would invite downgrade/confusion bugs and fragment persistent
formats. Versioned protocol constants belong to the codec specification.

### Claim remote filtering or transactional updates

Google Sheets does not provide those database semantics. A smaller honest API
is safer than an abstraction whose guarantees disappear under concurrency.
