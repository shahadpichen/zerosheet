import {
  RecipientEncryptionKeyResponseSchema,
  WorkbookRotationResponseSchema,
  WorkbookSharingDetailsSchema,
} from "@zerosheet/contracts";
import { decodeGoogleRange, MAX_SYNC_CELLS } from "@zerosheet/sheet-core";
import { googleWorkspaceStorage } from "./google-storage.js";
import {
  recoverWorkbookEncryptionAccess,
  resumeWorkbookKeyRotation,
  rotateWorkbookKeyAndRevoke,
  SecureWorkbookClientError,
} from "./secure-workbook.js";
import { workspaceRequest } from "./workspace-client.js";

/** Metadata stays in component memory, never localStorage. The server gates
 * both operations with the same can_manage_sharing policy as the mutation. */
export async function loadWorkbookSharing(workbookId: string) {
  return WorkbookSharingDetailsSchema.parse(
    await workspaceRequest(`/workbooks/${workbookId}/secure-shares`),
  );
}

export async function lookupWorkbookRecipient(
  workbookId: string,
  email: string,
) {
  return RecipientEncryptionKeyResponseSchema.parse(
    await workspaceRequest(
      `/workbooks/${workbookId}/secure-shares/lookup`,
      "POST",
      { email: email.trim().toLowerCase() },
    ),
  );
}

/** Removal always rewrites the saved Google snapshot, never a stale editor
 * snapshot. The UI requires saved edits before opening sharing. We read the
 * registered tab's used values (not merely the editor's visible A1:Z100) so a
 * protected value outside the viewport cannot silently keep the revoked key.
 * Large sheets fail before staging; multi-range rotation needs a later format.
 */
export async function removeWorkbookAccess(input: {
  workbookId: string;
  revokedUserId: string;
  recoveryPhrase: string;
}) {
  const sharing = await loadWorkbookSharing(input.workbookId);
  if (sharing.owner.userId === input.revokedUserId)
    throw new SecureWorkbookClientError("ZEROSHEET_API_FAILED");
  if (
    sharing.rotation &&
    sharing.rotation.revokedUserId !== input.revokedUserId
  )
    throw new SecureWorkbookClientError("ROTATION_ALREADY_PENDING");
  // A crash after activating the key but before removing OpenFGA access needs
  // only the idempotent commit step, never another rewrite or another key.
  if (sharing.rotation?.state === "committed") {
    WorkbookRotationResponseSchema.parse(
      await workspaceRequest(
        `/workbooks/${input.workbookId}/encryption/rotations/${sharing.rotation.toKeyVersion}/commit`,
        "POST",
      ),
    );
    return;
  }
  const access = await recoverWorkbookEncryptionAccess(input);
  if ((access.rotationPending || access.pending) && !sharing.rotation)
    throw new SecureWorkbookClientError("ROTATION_ALREADY_PENDING");
  const before = await googleWorkspaceStorage.getSpreadsheet(
    access.spreadsheetId,
  );
  const tabs = await googleWorkspaceStorage.listSpreadsheetTabs(
    access.spreadsheetId,
  );
  const tab = tabs.find((value) => String(value.id) === access.sheetId);
  if (!tab) throw new Error("Registered tab is unavailable");
  const ranges = await googleWorkspaceStorage.batchReadValues(
    access.spreadsheetId,
    [`'${tab.title.replaceAll("'", "''")}'`],
  );
  const after = await googleWorkspaceStorage.getSpreadsheet(
    access.spreadsheetId,
  );
  if (before.version !== after.version || ranges.length !== 1)
    throw new SecureWorkbookClientError("GOOGLE_SHEET_CONFLICT");
  const source = ranges[0]!.values;
  const rows = Math.max(1, source.length);
  const columns = source.reduce(
    (maximum, row) => Math.max(maximum, row.length),
    1,
  );
  if (rows * columns > MAX_SYNC_CELLS)
    throw new SecureWorkbookClientError("ROTATION_TOO_LARGE");
  const range = {
    startRow: 0,
    endRow: rows - 1,
    startColumn: 0,
    endColumn: columns - 1,
  };
  const decoded = await decodeGoogleRange({
    context: {
      workbookId: input.workbookId,
      sheetId: access.sheetId,
      sheetTitle: tab.title,
      keyVersion: access.active.keyVersion,
      key: access.active.key,
    },
    range,
    values: Array.from({ length: rows }, (_, row) =>
      Array.from(
        { length: columns },
        (_, column) => source[row]?.[column] ?? null,
      ),
    ),
    ...(access.pending
      ? {
          recoveryKeys: new Map([
            [access.pending.keyVersion, access.pending.key],
          ]),
        }
      : {}),
  });
  const content = {
    workbookId: input.workbookId,
    revokedUserId: input.revokedUserId,
    spreadsheetId: access.spreadsheetId,
    sheetId: access.sheetId,
    sheetTitle: tab.title,
    range,
    cells: decoded.cells,
    protection: decoded.protection,
    expectedDriveVersion: after.version,
  };
  const result = access.pending
    ? await resumeWorkbookKeyRotation({
        ...content,
        pendingKey: access.pending.key,
      })
    : await rotateWorkbookKeyAndRevoke(content);
  if (result.status === "pending")
    throw new SecureWorkbookClientError("ROTATION_ALREADY_PENDING");
}
