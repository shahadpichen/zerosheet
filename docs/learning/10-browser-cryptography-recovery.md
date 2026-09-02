# Milestone 10: Browser cryptography and recovery

## What this milestone establishes

ZeroSheet now has a storage-independent cryptographic core that can run in the
browser before the Google adapter or spreadsheet editor exists. It provides:

- a generated checksummed 12-word BIP39 recovery phrase;
- an HPKE P-256 user key pair generated in browser Web Crypto;
- a publishable versioned public key and SHA-256 fingerprint;
- a Capsule-encrypted backup of the serialized private key;
- random 256-bit workbook keys;
- one HPKE workbook-key envelope per exact recipient;
- compact, versioned AES-256-GCM encryption for individual cells; and
- a repeatable 100-by-100 cell benchmark with no secret output.

This milestone deliberately does not store keys in PostgreSQL, call Google,
render a spreadsheet editor, or decide who is authorized to receive an
envelope. Those integration workflows belong to later milestones.

## The key hierarchy, from top to bottom

```text
12-word recovery phrase
  -> BIP39 seed
  + random per-backup salt
  -> HKDF-SHA-256 wrapping key
  -> AES-256-KW unwraps Capsule's random data key
  -> AES-GCM opens the serialized HPKE private key

HPKE user key pair
  public key -> public ZeroSheet directory record
  private key -> encrypted backup at rest; usable handle in authorized browser

random workbook key
  -> AES-256-GCM protects every selected cell in that workbook key version
  -> HPKE seals one copy for the creator
  -> later, HPKE seals a separate copy for each collaborator
```

The recovery phrase therefore does **not** directly encrypt a workbook or
cell. It recovers the user's private key. That private key opens that user's
workbook-key envelopes, and a workbook key opens that workbook's cells. This
separation is what makes sharing and future key rotation possible without
giving collaborators the creator's recovery phrase.

## What can be stored remotely

The following records are safe to place in ZeroSheet PostgreSQL or Google
storage because none is usable alone to decrypt a protected cell:

- the user's public key, key version, suite, and fingerprint;
- the phrase-encrypted private-key Capsule;
- per-recipient HPKE workbook-key envelopes;
- `zs1` encrypted cell values; and
- workbook/tab/coordinate/key-version metadata needed to find and authenticate
  those values.

The recovery phrase, opened private key, raw workbook key, and cell plaintext
must not be sent to those systems. The browser may hold them while unlocked.

## Why the public key is not SHA-256

The public key is an actual P-256 elliptic-curve key used by HPKE. SHA-256 is
only used to hash its canonical serialized bytes into a 64-character
fingerprint. The fingerprint is convenient for comparison, pinning prompts,
and detecting a mismatched database record. It cannot decrypt data and does not
replace validation of the public key itself.

## Why HPKE instead of RSA

HPKE is the standardized recipient-encryption construction in RFC 9180. It
combines an ephemeral key agreement, a key derivation function, and AEAD with
defined context binding. ZeroSheet begins with it now so there is no custom RSA
envelope to migrate later.

Version 1 uses:

```text
DHKEM(P-256, HKDF-SHA-256)
+ HKDF-SHA-256
+ AES-256-GCM
```

P-256 has broad Web Crypto support. The suite name and format versions are
persisted, so adding a future suite means adding a compatible reader rather
than silently changing old envelopes.

HPKE base mode proves that only the matching recipient private key can open an
envelope. It does not sign the envelope or prove who sent it. The authenticated
sharing API and immutable audit event carry the actor identity.

## AEAD and encrypted cells

AEAD means authenticated encryption with associated data. AES-GCM both hides
the cell value and detects tampering. ZeroSheet also supplies AAD containing:

```text
format version + workbook ID + stable tab ID + row + column + key version
```

AAD is visible context, not secret data. If ciphertext is copied to another
coordinate, the reconstructed AAD changes and decryption fails. A legitimate
sort or move must therefore decrypt and re-encrypt locally for each new
coordinate.

One logical value produces one textual Google Sheet cell:

```text
zs1:<workbook-key-version>:<base64url nonce+ciphertext+tag>
```

The first plaintext byte records whether the value is blank, boolean, number,
string, or formula. That prevents a decrypted number from accidentally
becoming text and changing spreadsheet behavior. The exact contract and stable
test vector are in `docs/specifications/encrypted-cell-v1.md`.

## Recovery memory behavior

`RecoveryPhraseMemory` keeps the normalized phrase only in JavaScript memory,
binds it to the immutable ZeroSheet product-user ID, and invalidates in-flight
work if the account is locked or changed. It intentionally has no
`localStorage` or `sessionStorage` persistence. Refreshing the page will require
the phrase again unless a later, separately reviewed unlock mechanism is added.

JavaScript strings cannot be reliably overwritten, so dropping references is
best effort rather than guaranteed memory erasure. Active XSS, a malicious
browser extension, a compromised device, or a malicious frontend build can
read live keys and plaintext. Browser E2EE makes the delivered frontend part of
the trusted computing base.

## Benchmark and what it means

Run:

```bash
pnpm crypto:benchmark:cells
```

On the initial development machine, 10,000 mixed cells encrypted in about 168
ms and decrypted in about 174 ms. The stored UTF-8 representation was 536,830
bytes for 74,350 serialized plaintext bytes, a 7.22 ratio. This high ratio is
expected for tiny values because every cell pays nonce, authentication-tag,
type-tag, prefix, and base64 overhead.

Those numbers are a regression baseline, not a promise for every browser or
device. The important assertions are that all 10,000 values decrypt, all 10,000
ciphertexts are unique, and the benchmark never prints a key, nonce,
plaintext, or ciphertext.

## What this does and does not protect

It protects cell confidentiality and integrity when Google or an ordinary
ZeroSheet server reads stored data. It does not hide workbook structure,
protected coordinates, approximate value length, key versions, or update
timing. It does not prevent deletion, denial of service, recipient screenshots,
or rollback of an older authentic ciphertext into the same coordinate.

The full list of assumptions and residual risks is maintained in
`docs/security/threat-model.md`. Treat that file as part of the product
contract, not optional security prose.
