# ZeroSheet encrypted cell format version 1

## Status and scope

This document specifies the `zs1` textual cell representation written by
`@zerosheet/crypto`. It is storage-independent, but designed to fit one logical
encrypted value in one Google Sheets cell.

Version 1 supports blank, boolean, finite IEEE-754 number, UTF-8 string, and
formula values. Formatting, comments, attachments, array formulas, rich text,
errors, and workbook manifests are outside this version.

The cryptographic construction uses AES-256-GCM through the
[Web Cryptography API](https://www.w3.org/TR/WebCryptoAPI/).

## Text grammar

```text
encrypted-cell = "zs1:" key-version ":" base64url-payload
key-version    = canonical lower-case base36 integer from 1 through 2^32-1
base64url      = unpadded RFC 4648 URL-safe base64
```

Example shape:

```text
zs1:1:<nonce-and-authenticated-ciphertext>
```

`zs1` is the encrypted format version. The second field is the workbook-key
version, allowing a client to select the right local key envelope before
decryption. Both are visible metadata.

Decoders reject non-canonical base64url, leading-zero/non-canonical key
versions, missing fields, unknown `zsN` versions, payloads below the minimum,
and payloads above the version-1 maximum.

## Binary payload

After base64url decoding:

| Offset | Length            | Meaning                                     |
| ------ | ----------------- | ------------------------------------------- |
| 0      | 12 bytes          | Fresh random AES-GCM nonce                  |
| 12     | serialized length | Encrypted tagged cell value                 |
| varies | 16 bytes          | AES-GCM authentication tag, appended by API |

Every call to the public `encryptCell` operation generates a new 96-bit nonce
with `crypto.getRandomValues`. Callers cannot supply a nonce. The deterministic
inner operation is intentionally not exported from the package root and exists
only for reproducible test vectors.

Reusing one nonce with the same workbook key can destroy AES-GCM security. A
storage adapter must persist the returned complete value and must never try to
construct or edit payload bytes.

## Plain cell serialization

The authenticated plaintext begins with one byte:

| Tag | Value kind | Remaining bytes                                |
| --- | ---------- | ---------------------------------------------- |
| 0   | blank      | none                                           |
| 1   | boolean    | none; value is false                           |
| 2   | boolean    | none; value is true                            |
| 3   | number     | one 8-byte IEEE-754 binary64 value, big-endian |
| 4   | string     | UTF-8 bytes                                    |
| 5   | formula    | UTF-8 bytes beginning with `=`                 |

Numbers must be finite. Positive/negative zero and finite binary64 values are
preserved. Invalid UTF-8, extra bytes on fixed-size types, non-finite numbers,
and a formula without an initial `=` are malformed.

The maximum tagged plaintext is 1 MiB in the crypto core. Google Sheets may
apply a much smaller cell limit; the Google adapter must enforce its current API
constraint before encryption and produce a product-specific validation error.

Encrypting a blank value is intentional: it hides whether a protected selected
cell is empty. Clearing a selected protected cell is a product operation that
decides whether to write an encrypted blank or remove the stored value.

## Authenticated context

The following UTF-8 JSON array is passed to AES-GCM as Additional Authenticated
Data (AAD), in this exact order and with the platform's standard JSON number and
string encoding:

```json
[
  "zerosheet:cell",
  1,
  "<workbookId>",
  "<stable sheetId>",
  "<zero-based row integer>",
  "<zero-based column integer>",
  "<workbook key version integer>"
]
```

The displayed placeholders above describe types; an actual encoded array uses
JSON numbers for row, column, and key version.

AAD is not encrypted or stored in the cell. The authorized client reconstructs
it from trusted workbook state and the target location. Changing the workbook,
sheet/tab, row, column, or key version causes authentication failure.

Therefore sorting, moving, or pasting protected values must decrypt locally and
reencrypt each value for its destination. Copying ciphertext bytes to a new
coordinate is invalid by design.

The sheet ID is a stable Google sheet/tab identifier, not its mutable title.
The workbook ID is ZeroSheet's stable logical identifier, not a display name.

## Overhead

Binary overhead is 29 bytes per cell before text encoding:

```text
12-byte nonce + 16-byte GCM tag + 1-byte value tag
```

Text storage adds the `zs1:<keyVersion>:` prefix and base64url expansion. Very
short values therefore have a high ratio even though the fixed binary overhead
is small. Text length also leaks an approximation of plaintext length; version
1 does not pad values.

## Normative test vector

These values are public test material and must never be used for real data:

```text
AES key (hex):
000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f

Nonce (hex): a0a1a2a3a4a5a6a7a8a9aaab
Workbook ID: workbook-test-01
Sheet ID: google-sheet-tab-0
Row: 4
Column: 2
Workbook key version: 1
Value: string "Acme Corp"

Stored value:
zs1:1:oKGio6Slpqeoqaqr4lkfQCDrQdAQFRaZnP9BKVjiQr-gY7QtKs8
```

Any change to this vector is a breaking format change and requires a new format
version or a deliberately implemented legacy reader.

## Security properties and limits

- Confidentiality and authenticity depend on the secrecy of the 256-bit
  workbook key and unique nonces under that key.
- AAD detects cross-location ciphertext swapping.
- Authentication failure never returns partially decoded plaintext.
- The format does not prove who authored a value.
- The format does not detect rollback of an older authentic ciphertext to the
  same cell and key version. A future authenticated workbook revision/manifest
  is needed for freshness.
- The format reveals its version, workbook-key version, protected-cell
  positions, approximate value lengths, sheet structure, and update timing.
- Google cannot calculate, filter, sort, chart, or search encrypted values.
  Those operations run on plaintext in the authorized client.
