# Workbook browser and saved editor

## What changed

Signing in opens a ZeroDrive-style **Home** hub: welcome, four navigation cards,
recent workbooks, and a security/setup panel. Home is separate from the file
browser. A locked tab sees recovery guidance and does not fetch workbook metadata.
The **Workbooks**, **New workbook**, **Shared with me**, and **Recovery & Access**
cards all lead to working destinations, not placeholders.

The separate Workbooks page matches ZeroDrive's storage pattern: a quiet Home
link, header actions, search/filter/sort, borderless icon tiles, and a compact
table. Folder and spreadsheet PNG icons are reused from ZeroDrive. Existing
shadcn components and semantic tokens drive both light and dark themes. The
table says **Created**, because the API does not provide modification dates;
folder dates and byte sizes are not invented. Delete/rename remain absent until
their APIs exist.

Routes are `/home` (also `/` after login), `/workbooks`, `/workbooks/new`,
`/shared-with-me`, `/recovery-access`, `/workbooks/folders/<uuid>`, and
`/workbooks/<uuid>`. Folder links and the editor's return destination preserve
the folder context. Ordinary links navigate in-page to retain memory-only keys;
modified clicks still support a new tab, which must unlock independently.
Recovery uses the existing full-page two-column setup, never a nested dialog.
Opening Recovery & Access while unlocked shows status, not the secret words.

Folders are personal product metadata. Moving a workbook changes only its
placement for that user, not its Google parent, organization, permissions, or
encryption key. Folder names and workbook names are not encrypted. The composite
database foreign key prevents a placement from referencing another user's folder.

## How creation and reopening work

1. Before a workbook destination opens, the shared recovery gate checks for an existing
   identity. New accounts start on **Create new key**; existing accounts start
   on **Recover existing key**. Lookup errors never offer key creation.
   Creation requires the warning acknowledgements, displays the 12 words with
   explicit local copy/download actions, and asks the user to confirm a backup.
   Generating the words alone does not register an identity. A downloaded phrase
   is an unencrypted secret file, and clipboard history/sync may retain copies.
2. The browser generates the HPKE identity and phrase-encrypts the private-key
   backup using the existing Capsule implementation. Only public material and
   an encrypted backup reach the API; an additional encrypted copy is attempted
   in Google appData. A failed optional copy does not invalidate the DB backup.
   Before continuing, the browser opens the saved backup to verify recovery.
   Retrying a lost registration response opens the existing backup with the
   same words; it never silently replaces the key. Existing accounts cannot
   create another identity through this screen. ZeroDrive legacy JSON imports
   are deliberately absent: they are not ZeroSheet HPKE identity backups.
3. The user chooses a writable organization; their first workbook can create a
   named personal workspace. Existing product services provision OpenFGA tuples.
4. Creation saves the product workbook, creates a Google spreadsheet, and stores
   the creator's HPKE key envelope **before** any encrypted cell upload.
5. The browser opens the stored envelope using the user's recovered private key,
   reads the actual Google values, and verifies/decrypts protected cells locally.
6. **Save** first commits the inline edit, checks fresh edit permission and key
   version, then sends a snapshot through the existing encrypted sync session.
   Later edits remain dirty; failures never report success. Google file versions
   detect normal external changes, but Sheets has no atomic compare-and-swap.

An incomplete creation stays visible as **Setup incomplete**. The owner can
finish it without replacing an already committed key. A failed multi-system
creation may leave an empty Google file; there is no destructive automatic cleanup.

### Empty sheets and recovery actions

Google omits the `values` property when a requested range is entirely empty.
The storage adapter turns this omission into `[]`, and the sync layer fills the
editor's requested rectangle with blank cells without writing anything. An
explicit `null` or malformed array still fails closed: it must not be mistaken
for a blank file that could later overwrite unread data.

The editor offers **Sign in again** only for an expired app session or missing/
expired Google authorization. An API outage, denied file permission, or invalid
response is not a reason to log in again. Safe error categories survive the
sheet sync wrapper; raw provider messages, tokens, and cryptographic causes are
never rendered. A locked recovery session is also distinct from incorrect words.

## Why saving is explicit

Automatically uploading every keystroke could reveal a sensitive value before
the user selects it for protection. This first connected editor uses Save/Cmd+S
and an unsaved-navigation warning. Unprotected values remain visible to Google.
Unprotected deletions become empty strings because the [Google values API skips
null values](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values).

The gate retains the requested workbook URL and returns there after recovery.
Recovery access lives only in page memory, bound to the product UUID. Reload,
sign-out navigation, or **Lock recovery access** drops it. Every reopen restores
protection from authenticated ciphertext rather than a browser-storage flag.
This storage behavior is intentionally unchanged by matching ZeroDrive's UI.

## Current boundaries—not a full spreadsheet product yet

- This editor handles the registered tab, at most **A1:Z100**, saving values,
  formulas, and selective protection. Other cells are untouched. Structural
  changes, additional tabs, and persisted formatting need a later format/UI pass.
- Normal Google files are not automatically imported. The browser lists
  ZeroSheet-registered workbooks authorized through OpenFGA **and** OPA.
- Sharing/key-rotation coordinators already exist, but this change does not add
  share-management dialogs or folder-sharing. Shared workbooks appear when the
  necessary product share, Google permission, and recipient envelope exist.
- Rename, trash, folder deletion, and realtime collaboration are not part of
  this increment. The UI does not show nonfunctional buttons for those actions.
- Listing is paginated over 50 candidates, with policy checks before metadata
  leaves the API. Search/sort apply to loaded workbooks. Folders are limited to
  500 per user and the workspace selector returns up to 100 organizations.

## Verify it

Run `pnpm infra:db:migrate`, then start the existing API/web development servers.
`pnpm typecheck`, `pnpm lint`, and the API/web/storage test suites check contracts,
permission filtering, state changes, and Google deletion semantics.

Opt-in SQL test (isolated random fixtures, removed afterward):

```sh
ZEROSHEET_RUN_DB_INTEGRATION=true pnpm --filter @zerosheet/api exec vitest run src/workspace/repository.integration.test.ts
```

Browser test using an available Playwright installation:

```sh
ZEROSHEET_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs ZEROSHEET_BROWSER_CHANNEL=chrome node infra/scripts/verify-workbook-browser.mjs
```

This exercises real React, Univer, and cryptography against mocked API/Google
transport: the locked/unlocked Home hub, all four destinations, folder creation,
moving workbooks, nested breadcrumbs, table/grid/search/sort, retained editor
return paths, first-page creation/recovery, unavailable identity lookups, required
backup acknowledgements, lost registration responses, prevention of key
replacement, create/protect/save, failures, reopen, reload/unlock, locking,
empty Google responses, load retries, context-appropriate sign-in actions,
retained editor URLs, both themes, and narrow mobile layouts. It uses a clean browser profile and does
not modify a personal Google account. Real Google consent/API access still needs
a manual acceptance run with a disposable workbook.
