# ZeroSheet security and privacy threat model

## Scope

This threat model covers the IAM controls, browser cryptography, delegated
Google storage boundary, selective-protection editor, direct user sharing, and
workbook-key rotation introduced through Milestone 13.

The goal is end-to-end confidentiality for protected workbook values: Google
and ordinary ZeroSheet hosted services should store or transport ciphertext but
should not possess the recovery phrase, usable user private key, plaintext
workbook key, or protected cell plaintext.

## Assets

- protected cell values and formulas;
- random workbook content keys and their historical versions;
- each user's HPKE private key;
- the creator's 12-word recovery phrase;
- Google OAuth access/refresh credentials;
- human sessions and enterprise lifecycle state;
- workbook/team/share relationships and audit evidence; and
- SPIRE signing keys and workload SVID private keys.

Public HPKE keys, their SHA-256 fingerprints, SPIFFE IDs, and trust bundles are
identifiers/verification material, not secrets.

## Trusted components

- the authorized user's device, operating system, browser, and active
  ZeroSheet JavaScript;
- browser Web Crypto and its random-number generator;
- reviewed `@zerosheet/crypto`, pinned Capsule, and pinned HPKE code;
- the pinned Apache-2.0 Univer editor build and the reviewed ZeroSheet adapter
  that translates between editor values and the encrypted storage format;
- Keycloak for human authentication, not decryption;
- OpenFGA and OPA for authorization decisions, not key possession;
- SPIRE for workload identity, not workbook access; and
- the deployment pipeline that builds and serves the reviewed frontend.

Trust is purpose-limited. For example, Keycloak may assert who signed in, but it
cannot grant itself a workbook decryption key. SPIRE may authenticate the
worker, but that SVID is not an HPKE recipient key.

## Adversaries considered

1. A database administrator or database dump thief who can read/modify product,
   Keycloak, or authorization state.
2. A Google storage/API operator or attacker who obtains Sheet ciphertext and
   structural metadata.
3. A network attacker between browser, ZeroSheet, Google, or internal services.
4. Another authenticated ZeroSheet user without a workbook relationship or key
   envelope.
5. A removed collaborator attempting to use stale authorization or retained
   keys.
6. A malicious or compromised internal workload attempting to impersonate a
   different workload.
7. A malicious spreadsheet value attempting formula injection or parser abuse.
8. A rollback/swapping attacker who can rearrange or restore stored ciphertext.

## Security goals

- Protected values are encrypted and authenticated in the browser before a
  remote write.
- A random workbook key, not a password-derived key, encrypts cells.
- Each cell nonce is fresh and each ciphertext is bound to workbook, sheet,
  coordinate, and key version.
- The user private key is generated in the browser. Only its public half and an
  authenticated phrase-encrypted private backup may leave the browser.
- Workbook keys leave a client only inside an exact recipient's HPKE envelope.
- Human authentication, relationship authorization, contextual policy, key
  possession, and Google Drive permission remain independent controls.
- Internal workloads use short-lived mutually authenticated identities rather
  than shared service credentials.
- Invalid, unavailable, expired, or ambiguous security state fails closed.

## Explicit non-goals and residual risks

### Compromised client or supplied JavaScript

An active same-origin XSS, malicious browser extension, compromised device, or
malicious frontend build can read plaintext and keys while the user works. E2EE
does not protect data from the code entrusted to decrypt it. Strict CSP,
dependency review, reproducible builds, release signing, minimal third-party
scripts, and prompt patching are required deployment controls.

JavaScript strings cannot be reliably zeroed, and Web Crypto controls the
internal lifetime of `CryptoKey` objects. Byte arrays are cleared on best effort
paths, but this is not proof that runtime/OS copies vanished.

### Google OAuth authority and server compromise

The BFF must retain offline Google authority so it can refresh short-lived
browser access tokens. PostgreSQL stores the refresh token only as an
AES-256-GCM envelope bound to the immutable product-user ID; the independent
deployment key stays outside the database. This protects a database dump alone,
not a live service compromise.

An attacker controlling the API process, or an administrator with both the
database and deployment key, can decrypt a refresh token and operate within
`drive.file` and `drive.appdata`. That can expose unprotected cells, ciphertext,
file metadata, and the encrypted private-key backup, and can modify or delete
those records. It does not yield the recovery phrase, opened HPKE private key,
or workbook key needed to decrypt protected cells.

An active same-origin XSS can steal the current browser access token even though
it is never persisted. The short lifetime and narrow scopes reduce impact but
do not remove it. Strict CSP, reviewed dependencies, fixed API origins, and
rapid revocation remain required.

### Availability, deletion, and rollback

Encryption does not stop Google, a server administrator, or an attacker with
write access from deleting ciphertext, denying access, exhausting quotas, or
restoring an older authentic value. Cell AAD prevents moving ciphertext to a
different coordinate, but does not detect replay in the same coordinate. A
future authenticated workbook manifest/revision chain is needed for freshness.

Backups remain necessary. Named Docker volumes and Google revision history are
not by themselves tested disaster recovery.

### Metadata leakage

The system can reveal:

- account, organization, team, workbook, and share existence;
- Google spreadsheet and stable tab identifiers;
- sheet dimensions and which coordinates contain `zsN` markers;
- encrypted value lengths and workbook-key versions;
- access, update, share, revocation, and synchronization timing;
- IP/user-agent data at infrastructure or Google boundaries; and
- public-key versions and fingerprints.

Version 1 uses no cell padding or private contact-discovery protocol. Product
claims and privacy documentation must describe this honestly.

### Authorized recipients

An authorized recipient can view plaintext and may copy, export, photograph, or
re-share it. Revocation prevents future server-authorized access and future key
versions; it cannot erase plaintext or keys already retained on a recipient's
device. Rotation must be described as forward-looking, not remote deletion.

### Sharing coordination and partial failure

A secure share spans systems that cannot participate in one database
transaction: Google Drive permission, the ZeroSheet recipient envelope, and the
OpenFGA relationship. The browser creates the Google permission first because
the provider returns the exact permission ID needed for a precise rollback. It
then asks the API to validate and persist the opaque HPKE envelope together with
the durable relationship intent. If that API step fails, the browser attempts
to delete only the permission created by that share attempt.

The rollback is best effort. A crash or loss of network between those calls can
leave Google access without ZeroSheet authorization or a usable envelope. That
state exposes Google-visible metadata and unprotected values, but it does not
grant decryption of protected cells. Reconciliation and audit alerting are
required in production. A recipient's ZeroSheet primary email may also name a
different Google account, so the sharing UI must display and confirm the exact
Google address rather than assuming equivalence.

### Rotation and revocation windows

Revocation is a staged saga rather than a single delete. The owner creates one
fresh workbook key, seals it to the exact current key version of every remaining
direct recipient, persists the complete envelope set, rewrites the bounded
sheet range, removes the revoked Google permission, and finally advances the
active key version while removing the OpenFGA relationship. Until completion,
the old authorization and old ciphertext remain valid; after completion, a
recipient who retained the old key may still decrypt an old copy.

The pending rotation record and envelopes allow the same owner to resume after
a browser, provider, or network failure without inventing another key. Version
1 supports one bounded range of at most 10,000 cells and direct users only.
Encrypted team sharing is denied because correct membership fan-out and
rotation on every joiner/leaver event are deferred. Multi-range rewrite,
provider reconciliation, and automated recovery are Milestone 14 hardening
work, not properties that the current product should claim.

### HPKE sender authentication and public-key directory

ZeroSheet uses HPKE base mode to encrypt workbook keys to recipients. It proves
recipient exclusivity, not who created the envelope. The authenticated product
API and audit log establish the sharing actor separately.

A malicious public-key directory can substitute a key at first contact. A
SHA-256 fingerprint detects accidental corruption and supports out-of-band
verification/pinning, but it is not a certificate authority or key-transparency
log. Silent server rollback of an older valid public-key version also needs a
future transparency/history control.

### Recovery loss

ZeroSheet cannot reconstruct a lost 12-word phrase. Without the phrase or an
approved future recovery recipient, the encrypted user private key cannot be
opened and existing workbook-key envelopes may become permanently unusable.
Authentication resets do not reset encryption.

### Local plaintext operations

Sorting, filtering, searching, formulas, charts, import, and export operate on
plaintext in the authorized client. Clipboard, downloaded exports, browser
caches, crash reports, screenshots, unsafe formula functions, and local
extensions can leak that plaintext. The editor must avoid network-capable or
dynamic-code formula functions unless they are explicitly sandboxed and
reviewed.

Univer is part of the trusted frontend while a workbook is open. ZeroSheet does
not give the engine a Google access token, recovery phrase, extractable workbook
key, or direct storage adapter. No third-party networking or Pro collaboration
plugin is enabled in this milestone. This separation reduces accidental token
leakage, but it cannot protect plaintext from a compromised editor dependency or
malicious frontend release.

Unprotected cells are intentionally ordinary Google values. The protection map
is coordinate-based, and a protected blank is encrypted so its marker survives
Google omitting trailing blanks. Anyone with Google access can still infer which
coordinates contain encrypted markers and approximate protected value lengths.

The sync session reads the Drive file version before and after a batch read and
checks it again before each serialized write. This detects ordinary concurrent
edits, but Drive's version check and the Sheets values write are separate API
calls. A remote edit in that narrow interval can still be overwritten. A future
authenticated workbook revision and merge flow are required before claiming
strong concurrent-edit protection.

## Key hierarchy

```text
12-word BIP39 recovery phrase (creator knows it)
  -> BIP39 seed + per-backup random salt + HKDF-SHA-256
  -> AES-256-KW owner wrapping key inside Capsule v1
  -> unwraps Capsule's random AES data key
  -> decrypts the user's serialized HPKE private key

Browser-generated HPKE P-256 key pair
  public key + version + fingerprint -> ZeroSheet public directory
  encrypted private-key Capsule      -> ordinary product storage is acceptable

Per-workbook random 256-bit key
  -> AES-256-GCM encrypted cells
  -> HPKE envelope for creator
  -> later: separate HPKE envelope for each authorized recipient
```

The recovery phrase does not directly encrypt every cell. This indirection
allows sharing and key rotation without revealing the phrase or re-deriving one
global content key across every workbook.

## Operational rules

1. Never log request bodies containing encrypted-key backups if log tooling may
   decode or expand them; record only safe IDs, versions, outcomes, and timing.
2. Never place recovery phrases, private keys, workbook keys, or Google tokens
   in URLs, analytics, crash metadata, process arguments, or Git.
3. Reject unknown encrypted versions; do not guess or silently treat them as
   plaintext.
4. Treat AES-GCM authentication failure as corruption/wrong context and never
   return partial data.
5. Require explicit confirmation when a previously pinned recipient public-key
   fingerprint changes.
6. Preserve old private-key versions while any retained workbook envelope may
   target them.
7. Separate dev/staging/production identity issuers, SPIFFE trust domains,
   OAuth clients, databases, and encryption test data.
8. Test backup restoration, key-loss UX, tampering, rollback controls, and
   revocation behavior before claiming production readiness.
