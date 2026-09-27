# Sharing from the workbook editor

## Try it with two accounts

1. Sign in to ZeroSheet with both Google accounts. Each person completes their
   own recovery setup and keeps their own 12 words. Never exchange those words.
2. As the owner, open a saved workbook and save any pending edits. Click **Share**.
3. Enter the recipient's exact Google email and click **Review access**. The
   recipient must be an active, unambiguous account with an encryption identity.
4. Check the address, choose **Viewer** or **Editor**, and confirm access. The
   expandable fingerprint identifies the selected public key. Comparing it
   through a separate trusted channel is an extra check, not automatic identity
   verification. A changed key requires a fresh review.
5. Copy the workbook link and send it yourself. No email notification is sent.
   The URL contains only the workbook ID; it does not contain a decryption key
   and cannot grant access by itself.
6. The recipient opens the link or **Shared with me**, unlocks with their own
   phrase, and sees the same saved workbook. Viewers cannot save; editors can.
   This is shared storage, not realtime collaboration: save, then reopen to see
   another person's changes. Avoid simultaneous edits.

The dialog follows the existing ZeroDrive-style square borders, semantic light/
dark colors, and shadcn/Radix accessibility primitives. Sharing is per workbook;
personal folder placement does not change Google permissions or anyone else's
folder structure. Only actors passing `can_manage_sharing` can inspect or edit
the sharing list. Editors do not automatically get that permission.

## Where the key goes

```text
Owner's 12 words (browser only)
  -> open owner's encrypted private-key backup
  -> open owner's workbook-key envelope from ZeroSheet
  -> HPKE-encrypt that same workbook key to recipient's public key
  -> save recipient's opaque envelope in ZeroSheet

Recipient's own 12 words (browser only)
  -> open recipient's encrypted private-key backup
  -> open their workbook-key envelope from ZeroSheet
  -> decrypt protected cells read from the shared Google file
```

The recipient does not need to store a raw workbook key in Google Drive. They
can reopen the envelope after a reload. The optional Google appData backup is
their phrase-encrypted **private-key backup**, not a shared plaintext workbook
key. Transient raw workbook-key bytes are cleared after wrapping/importing.

## What happens when access changes

Three controls must agree: the Google user permission, the ZeroSheet/OpenFGA
role, and the encrypted recipient envelope. A role change reuses the managed
Google permission; it never deletes a viewer's permission just to upgrade them.
Existing permissions managed outside ZeroSheet require review rather than
automatic adoption. **Check Google permissions** reports missing/unmanaged
permission IDs without changing anything; it does not verify every Google role
or inherited group access.

**Remove** asks for confirmation, reads the saved Google tab, creates a new
workbook key, and seals it only to remaining recipients. It then re-encrypts
protected cells, removes the direct Google permission, and removes the app
share. Cells outside the visible editor are included in the used rectangle.
Removal cannot erase already downloaded plaintext, ciphertext, or old keys.
Other Google grants, such as group/domain permissions, need separate review.

Edits are frozen while the dialog is open; unsaved edits must be saved first.
Google permission mutations change file versions, so the editor reloads after
the dialog closes following a mutation. API writes require the configured
frontend Origin in addition to an authenticated session and authorization.

## Failures and current limits

- A lost response does not prove a failed share. The browser rereads metadata
  before compensation. If state is uncertain, it preserves the permission and
  asks for review rather than deleting something another request may have saved.
- A failed rotation remains recoverable. Reopen **Share → Resume removal**.
  The browser opens the saved pending envelope and handles cells already
  re-encrypted under that key. It never generates a replacement pending key.
  If crypto committed but the relationship removal failed, retry finishes the
  same outbox deletion. Editing stays blocked while rotation is pending.
- Pending relationship operations are shown as incomplete, not successful.
  Refresh after the existing relationship reconciler has applied them. Do not
  delete keys or repeat a different grant to work around pending state.
- Direct-user sharing only; no team/folder sharing or account invitation emails.
- One registered Google tab and at most 10,000 cells in its used rectangle for
  removal. A larger rectangle fails before a new rotation is staged.
- Google and PostgreSQL/OpenFGA cannot commit atomically. Browser crashes and
  out-of-band Google edits can still cause drift. Do not mutate a workbook's
  shares concurrently from multiple devices/tabs. Google version checks are
  not atomic write locks; this is not a realtime multi-writer protocol.
- Fingerprints are checked against the server directory, not a separate key
  transparency service. This does not defend against a malicious app delivering
  modified JavaScript or substituting an unverified recipient key.

## Verification

Unit tests cover authorization, strict input/origin checks, key-change review,
managed role updates, compensation, and mixed-version decoding. The opt-in
PostgreSQL test covers lookup, active/pending/committed metadata, duplicate
staging refusal, retrying a pending deletion, and later re-invitation.

`infra/scripts/verify-workbook-browser.mjs` uses two isolated accounts and real
browser cryptography, with mocked Google/API transport. It verifies recipient
decryption, viewer restrictions, editor saves, interrupted removal/resume,
rotation beyond the viewport, old-key rejection, and revoked-save denial.
It also captures light/dark and mobile screenshots. It does not prove live
Google consent, project scopes, or sharing-policy settings: finish acceptance
with two real Google accounts and a disposable workbook before relying on it.
