# ADR 0002: Browser key hierarchy and encrypted cell format

- Status: Accepted
- Date: 2026-09-03

## Decision

Encrypt each protected logical cell independently with AES-256-GCM under a
random per-workbook key. Store it as the versioned compact textual `zs1`
format, and bind workbook ID, stable sheet ID, coordinate, and workbook-key
version as authenticated additional data.

Generate a versioned HPKE recipient key pair in the browser using RFC 9180
DHKEM(P-256, HKDF-SHA-256), HKDF-SHA-256, and AES-256-GCM. Publish only the
serialized public key and its SHA-256 fingerprint. Protect the serialized
private key with a ZeroDrive Capsule v1 owner-recovery envelope derived from a
checksummed 12-word BIP39 recovery phrase.

Encrypt each random workbook key to its creator through an HPKE envelope.
Multi-user workflows will create one envelope per authorized recipient rather
than storing or server-encrypting a plaintext workbook key.

## Why

- Per-cell ciphertext supports arbitrary selections, columns, sparse protected
  ranges, and batched Google Sheets writes.
- A spreadsheet-specific format avoids repeating a full file-container header
  in every small cell.
- AES-GCM supplies confidentiality and tamper detection with native browser
  support.
- Context AAD detects copying ciphertext to a different workbook location.
- Random workbook keys make sharing and rotation independent from the creator's
  recovery phrase.
- HPKE is a standardized recipient-encryption construction and avoids creating
  a new RSA format that would later need migration.
- P-256 has broad Web Crypto support and avoids shipping a custom curve
  implementation for the first browser release.
- Reusing Capsule's audited-by-project, storage-independent owner recovery
  format preserves the ZeroDrive design and avoids duplicating phrase KDF/key
  wrapping logic.

## Consequences

- Google sees a `zs1` marker, key version, cell coordinates/structure, timing,
  and approximate value length, but not authenticated plaintext.
- Google cannot natively calculate, search, sort, filter, or chart protected
  values; the authorized local editor performs those operations.
- Moving/sorting a cell requires local decryption and re-encryption for the new
  coordinate.
- The creator must retain the recovery phrase. An authentication reset cannot
  decrypt a lost private key.
- The encrypted private-key backup may be stored in PostgreSQL or Google Drive;
  neither location receives the phrase or a usable private key.
- HPKE base mode provides recipient confidentiality, not sender signatures.
- Cell-level AEAD does not prevent same-coordinate rollback. A future
  authenticated workbook manifest must provide freshness/conflict evidence.
- The P-256 choice is part of the versioned public-key and envelope contracts.
  A future suite is added beside it rather than silently changing version 1.
