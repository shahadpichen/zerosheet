# ADR 0005: Coordinate encrypted workbook sharing as a resumable saga

- Status: accepted
- Date: 2026-09-03

## Context

Opening a protected ZeroSheet workbook requires three independent facts:

1. Google Drive permits the Google account to read or edit the file.
2. OpenFGA permits the ZeroSheet product user to perform the requested action.
3. The user owns an HPKE envelope that their browser can open into the current
   random workbook key.

No trusted server should ever receive that raw workbook key. Google Drive,
PostgreSQL, and OpenFGA are also separate systems and cannot participate in one
ACID transaction. Treating any one of these controls as a substitute for the
others would either weaken authorization or break end-to-end encryption.

Revocation has another constraint: deleting a relationship or Drive permission
does not erase an old workbook key from a recipient's device. Future versions
must use a new key that is delivered only to the remaining recipients.

## Decision

ZeroSheet coordinates sharing and rotation as explicit, retryable sagas.

For a direct share, the browser fetches the recipient's authenticated product
identity and current public encryption key, seals the active workbook key to
that exact key version, creates an exact Google Drive permission, and finally
sends the role, permission metadata, and opaque envelope to the API. The API
validates and records the envelope first, then lets the existing product outbox
activate the OpenFGA relationship. If either API step fails, the browser makes
a best-effort rollback of the permission it just created. A stored envelope
without authorization is harmless and can be overwritten by an exact retry.

For revocation, the owner creates a fresh key and a complete envelope set for
all remaining direct recipients. The API stores those envelopes as a pending
rotation before any ciphertext rewrite. The browser writes the bounded sheet
range under that pending key, removes the revoked user's exact Google
permission, and then commits the rotation. Commit changes the active key version
and removes product authorization. The pending state is queryable so the same
owner can resume after a crash without creating an unrelated second key.

The API never decrypts an envelope, accepts a recovery phrase, or accepts raw
workbook-key bytes. Historical phrase-encrypted private-key backups remain
addressable by recipient key version because an older envelope may target one.

Encrypted team sharing is denied until member fan-out and joiner/mover/leaver
rotation are implemented. This is preferable to silently granting a team
relationship that lacks usable envelopes for some members.

## Consequences

- A database reader sees public keys, opaque envelopes, permission IDs, and
  structural metadata, but not a usable private key or workbook key.
- A recipient needs all three controls; authorization alone cannot decrypt.
- Partial failures are observable and resumable, but they remain possible.
- A share rollback can fail and therefore needs later reconciliation/auditing.
- Revocation protects future versions and is not remote deletion of retained
  plaintext, ciphertext, or historical keys.
- The first real Google write must follow durable creation of the creator's
  envelope, avoiding permanently undecryptable ciphertext.

## Alternatives rejected

### Store the raw workbook key in PostgreSQL

This would let a database reader or application operator decrypt every workbook
and would contradict the product's end-to-end confidentiality goal.

### Encrypt all workbook keys with one server environment secret

The running API necessarily has access to that secret, so a live compromise or
operator could decrypt protected content. It changes encryption at rest, not
the trust boundary.

### Use Google Drive permission as the only authorization control

Drive identity and ZeroSheet product identity are not interchangeable. It would
also bypass OpenFGA roles, tenant lifecycle checks, and encryption-key delivery.

### Delete authorization before rotating content

If rotation later failed, remaining users could lose access or new ciphertext
could exist without a complete envelope set. Staging the complete key material
first makes the forward transition recoverable.
