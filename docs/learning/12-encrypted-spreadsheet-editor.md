# Milestone 12: local spreadsheet editing and selective protection

## What this milestone proves

ZeroSheet can use a full spreadsheet engine while keeping its privacy logic
independent. The browser can edit values and formulas, protect an exact dragged
selection or whole columns, encode one Google-compatible batch, and decrypt the
batch again without exposing ciphertext or key material in the interface.

This is intentionally a safe technical spike. Its workbook key is generated in
memory and destroyed by a reload, so it does not upload. Milestone 13 will first
store an HPKE envelope for the creator; only then is durable Google autosave
safe. Identity and a Drive connection alone are not enough to recover content.

## The three layers

```text
Univer editor
  local grid, formulas, sort, filter, and find/replace
        |
        | values + formulas + exact selected coordinates
        v
@zerosheet/sheet-core
  protection map -> encrypted-cell codec -> serialized sync queue
        |
        | one bounded Google RAW value range
        v
@zerosheet/google-storage
  fixed Google origins + short-lived delegated access token
```

The separation matters. Univer has no OAuth token and does not know how to call
Google. The Google adapter has no recovery phrase or workbook key. Sheet core
sees the non-extractable browser `CryptoKey` only long enough to encrypt or
decrypt a selected range.

## What “protect selection” means

A cell is identified by its zero-based row and column. Dragging `B2:D8` records
that exact rectangle. Protecting selected columns expands the current columns
over the sheet's present row count. Removing protection deletes the same exact
coordinates from the map.

For each protected coordinate, the codec creates a fresh AES-GCM nonce and uses
the workbook ID, stable Google tab ID, row, column, and workbook-key version as
authenticated additional data. Moving a ciphertext marker to another cell
therefore fails authentication.

An empty protected cell is still encrypted. If it were sent as a normal blank,
Google could omit it from a response and the client would no longer know the
user protected that coordinate. The `zs1` marker makes the decision durable.

Unprotected cells remain normal strings, finite numbers, booleans, formulas, or
blanks. Google can read them. Selective encryption is not the same privacy model
as whole-workbook encryption, so the UI and marketing must state that clearly.

## The 10,000-cell batch

The codec accepts one rectangular range of at most 10,000 cells. It validates
the exact matrix size, encrypts protected cells, leaves the others plain, and
returns one `GoogleValueRange` with `valueInputOption=RAW` at the storage layer.
`RAW` prevents Google from interpreting ciphertext as a formula.

Run the deterministic benchmark with:

```bash
pnpm sheet:benchmark:sync
```

It creates a 100 × 100 matrix, protects half the cells, encrypts it, decrypts it,
and verifies every value. The timing is a development signal rather than a
production service-level objective because browsers and devices differ.

## Why saves are snapshotted and serialized

Autosave and a manual Save can happen nearly together. If both writes run at
once, the slower old write could finish last and overwrite the new data. The
sync session therefore keeps one promise queue and starts one write at a time.

Each call synchronously clones its range, cells, and protection map before it
joins that queue. Without that clone, typing or changing protection while the
save waits would mutate the data belonging to the earlier save.

## What the Drive version check can and cannot do

Loading reads the Drive file metadata, reads values, and reads metadata again.
Different versions mean the file changed during the read, so ZeroSheet rejects
the result rather than combining inconsistent data. Before saving, the session
checks the version it last observed. A mismatch becomes a visible conflict.

The limitation is important: Google does not provide one atomic operation that
says “write these Sheet values only if Drive is still version 42.” A remote edit
can occur between ZeroSheet's check and write. Milestone 12 documents this race;
a later revision/merge design is required for strong concurrent-edit safety.

## Why Univer is legally usable here

The pinned `@univerjs/presets` and four imported sheet preset packages declare
Apache-2.0 licenses. That license permits commercial use and marketing a product
built with the library, provided its license/notice conditions are followed.
ZeroSheet imports no `@univerjs-pro/*` feature. Separately licensed Pro features
must not be added without a new dependency and license review.

This is an engineering inventory, not legal advice. Release automation should
eventually produce the full third-party notice and software-bill-of-materials
from the locked dependency graph.

## Test map

- `protection-map.test.ts`: cells, dragged rectangles, columns, removal, limits.
- `codec.test.ts`: selective round trip, protected blanks, tampering, size cap.
- `sync-session.test.ts`: blank padding, load/write conflicts, serialized saves,
  immutable snapshots, and the mandatory load-before-save rule.
- `benchmark.ts`: 100 × 100 encode/decode measurement and exact value check.

## What comes next

Milestone 13 connects this editor to durable workbooks. It will create the
creator's HPKE envelope before the first remote write, add one envelope per
recipient, synchronize ZeroSheet/OpenFGA/Google Drive sharing, rotate workbook
keys for forward-looking revocation, and preserve historical keys where old
ciphertext still needs them.
