# ADR 0004: Univer editor with a storage-independent encryption boundary

- Status: accepted for Milestone 12
- Date: 2026-09-03

## Context

ZeroSheet needs spreadsheet editing, formulas, sort, filter, and search without
building a grid engine from scratch. It must also encrypt only the cells chosen
by the user: a single cell, a dragged rectangle, or whole selected columns.
Google Sheets remains the remote store, but Google must never receive protected
plaintext or the workbook key.

The editor and encryption code change for different reasons. A spreadsheet UI
upgrade should not silently change the persistent ciphertext format, and a new
storage provider should not require rewriting the protection rules.

## Decision

Use pinned Univer 0.25.1 Apache-2.0 packages for the local spreadsheet UI and
engine. Keep all ZeroSheet protection and synchronization behavior in
`@zerosheet/sheet-core`, which exposes plain structural types instead of Univer
classes. The browser adapter is the only translator between those two layers.

`CellProtectionMap` records exact zero-based coordinates. The encrypted cell
codec reuses `@zerosheet/crypto`, binds ciphertext to the stable workbook/tab
identity and coordinate, and creates one Google `RAW` value range containing no
more than 10,000 cells. Protected blanks are also encrypted; otherwise Google
would omit them and silently erase the protection decision.

`EncryptedSheetSyncSession` owns a stable Drive version after a successful
load. It reads before/after versions, checks again before writing, snapshots
each save request, and serializes queued writes. The live editor preview uses a
temporary in-memory key and verifies an encrypted round trip but does not
upload. Milestone 13 must persist the creator's HPKE envelope before enabling
real workbook autosave.

## Consequences

- Univer can be replaced without changing the encrypted cell/storage contract.
- Tests exercise encryption, corruption handling, selections, Google blank
  padding, conflict detection, and concurrent save serialization without a DOM.
- Unprotected cells remain readable by Google by explicit product design.
- The browser remains trusted for plaintext and can be compromised by XSS,
  extensions, device malware, or a malicious dependency/build.
- Google lacks an atomic compare-and-swap for Sheets value updates. Version
  checks reduce accidental overwrites but leave a documented check/write race.
- The OSS imports are usable commercially under Apache-2.0. This decision does
  not authorize importing separately licensed Univer Pro features.

## Rejected alternatives

### Encrypt every cell

This would provide a simpler privacy statement, but it would remove the product
requirement that users choose which data Google can index and manipulate.

### Store a separate protection manifest first

A manifest can eventually support richer authenticated workbook metadata, but
making the encrypted marker self-describing keeps Milestone 12 reload behavior
safe, including for protected blanks, without a second write dependency.

### Upload the technical-spike workbook immediately

The preview key disappears on reload. Uploading ciphertext before persisting a
creator envelope could create a permanently undecryptable Google Sheet, so the
write is intentionally blocked until Milestone 13.
