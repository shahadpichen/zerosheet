# Milestone 13: Secure workbook sharing and key rotation

This milestone connects the browser cryptography, Google adapter, product
database, OpenFGA authorization, and spreadsheet codec into one multi-user
lifecycle. Its central lesson is that **sharing is not one permission**.

## The three independent controls

An invited user can open protected values only when all three facts are true:

```text
Google Drive permission
        +
OpenFGA workbook role (viewer/editor)
        +
HPKE envelope for the active workbook-key version
        =
authorized browser can load and decrypt the workbook
```

- Google Drive controls whether a Google account can reach the file.
- OpenFGA controls what the authenticated ZeroSheet product user may do.
- The HPKE envelope gives that exact user's browser the cryptographic ability
  to recover the random workbook key.

Removing any one control denies a different layer. For example, a leaked Drive
link does not create a ZeroSheet session or decrypt protected cells.

## User encryption identity

The browser creates a P-256 HPKE key pair. It sends this safe directory record
to ZeroSheet:

```text
public HPKE key
public-key version
SHA-256 fingerprint of the canonical public key
phrase-encrypted private-key backup (Capsule)
```

The fingerprint is recomputed by the API; it is an identifier and corruption
check, not a secret or proof of ownership. The recovery phrase and opened
private key never enter an API request. The server retains historical encrypted
backups because an old workbook envelope can still name an old recipient-key
version after a user rotates their identity.

## Safe first write

A random 256-bit workbook key exists only in the creator's browser. Before the
browser uploads any `zs1` ciphertext, it seals that key to the creator's public
HPKE key and initializes the server record with the creator envelope. Only
after this succeeds does it write the encrypted Google range.

This ordering prevents a dangerous state where ciphertext is uploaded and its
only raw key disappears on refresh before any recoverable envelope exists.

## Direct sharing sequence

```text
owner browser
  1. GET recipient's current public key from authorized API
  2. HPKE-seal active workbook key to exact recipient/key version
  3. create exact Google user permission and retain its permission ID
  4. PUT role + Google permission metadata + opaque envelope to API
       -> API validates current recipient/key/envelope binding
       -> PostgreSQL saves envelope, then the durable relationship intent
       -> OpenFGA activates viewer/editor relation
  5. on API failure, delete the permission created in step 3
```

The API validates the P-256 points, canonical base64url fields, algorithm suite,
recipient ID, public-key fingerprint, and key versions. It deliberately cannot
open the envelope. The Google address should be shown explicitly in the UI;
the user's product email is not proof that it is the desired Google account.

## Why rollback cannot be perfect

Google and ZeroSheet do not offer a distributed transaction. If the browser
crashes after creating a Drive permission but before calling the API, automatic
rollback cannot run. The extra permission exposes only what Google can see:
metadata, unprotected cells, and protected ciphertext—not the HPKE workbook
key. Milestone 14 adds reconciliation and operator visibility for such drift.

The delete operation is idempotent: a missing permission is already the desired
state. That makes retries safe.

## Revocation means rotation

Deleting a relationship cannot make someone forget a key they already opened.
ZeroSheet therefore treats revocation as forward-looking key rotation:

```text
1. calculate remaining direct recipients and their exact current public keys
2. generate a fresh random workbook key in the owner's browser
3. create one new envelope for every remaining recipient
4. stage the complete envelope set as a pending key version
5. re-encrypt and write the bounded Google range using the pending key
6. delete the revoked user's exact Google permission
7. commit: activate the new key version and remove the OpenFGA share
```

If a failure happens after step 4, the pending rotation remains. The owner's
browser can recover the pending key from its own pending envelope and resume the
same rewrite. The API refuses incomplete or duplicate envelope sets.

## Current limits stated honestly

- Revocation protects future workbook versions; it cannot erase retained
  plaintext, screenshots, exports, old ciphertext, or old keys.
- The current rewrite is one rectangular range of at most 10,000 cells.
- Encrypted sharing supports direct users. Team sharing is blocked until every
  member can receive an envelope and membership changes trigger rotation.
- A narrow Google Drive version-check/write race remains because Sheets offers
  no atomic compare-and-swap for a values write.
- Partial share and provider state require reconciliation before production.

## What the server stores

PostgreSQL stores public user keys, their fingerprints and versions,
phrase-encrypted private-key backups, opaque recipient envelopes, Google file
and permission identifiers, active/pending workbook key versions, and rotation
state. It never stores a recovery phrase, opened HPKE private key, raw workbook
key, or protected plaintext.

## Verification

With the Docker infrastructure running:

```bash
pnpm infra:sharing:verify
```

The verifier replays the migration, runs API sharing/validation tests, Google
permission tests, cryptographic primitive tests, a real PostgreSQL lifecycle
test, and API/web type checks. The integration test uses synthetic IDs and
cleans its fixture rows.
