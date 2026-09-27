import { WorkbookEncryptionAccessResponseSchema } from "@zerosheet/contracts";
import {
  type DecodedSheetRange,
  type EncryptedSheetSyncSession,
  type GridRange,
} from "@zerosheet/sheet-core";
import {
  createGoogleSheetSyncSession,
  googleWorkspaceStorage,
} from "./google-storage.js";
import {
  recoverWorkbookEncryptionAccess,
  SecureWorkbookClientError,
} from "./secure-workbook.js";
import {
  loadWorkbook,
  workspaceRequest,
  WorkspaceRequestError,
} from "./workspace-client.js";

// The current encryption/rotation format stores one tab identity. Expose that
// tab and a bounded range, not an unlimited grid that silently loses extra cells.
export const EDITOR_RANGE: GridRange = {
  startRow: 0,
  endRow: 99,
  startColumn: 0,
  endColumn: 25,
};
export interface LoadedWorkbook {
  readonly id: string;
  readonly name: string;
  readonly canEdit: boolean;
  readonly sheetId: string;
  readonly sheetTitle: string;
  readonly keyVersion: number;
  readonly range: GridRange;
  readonly decoded: DecodedSheetRange;
  readonly sync: EncryptedSheetSyncSession;
}

/** Recover persisted key material, then authenticate/decrypt the visible range
 * before handing it to the editor. Never manufacture a fallback workbook key. */
export async function openSavedWorkbook(
  id: string,
  phrase: string,
): Promise<LoadedWorkbook> {
  const file = await loadWorkbook(id);
  const access = await recoverWorkbookEncryptionAccess({
    workbookId: id,
    recoveryPhrase: phrase,
  });
  if (access.rotationPending || access.pending)
    throw new SecureWorkbookClientError("ROTATION_ALREADY_PENDING");
  const tabs = await googleWorkspaceStorage.listSpreadsheetTabs(
    access.spreadsheetId,
  );
  const tab = tabs.find((item) => String(item.id) === access.sheetId);
  if (!tab) throw new Error("The encrypted tab is no longer available");
  const range = {
    ...EDITOR_RANGE,
    endRow: Math.min(EDITOR_RANGE.endRow, tab.rowCount - 1),
    endColumn: Math.min(EDITOR_RANGE.endColumn, tab.columnCount - 1),
  };
  const sync = createGoogleSheetSyncSession({
    spreadsheetId: access.spreadsheetId,
    context: {
      workbookId: id,
      sheetId: access.sheetId,
      sheetTitle: tab.title,
      keyVersion: access.active.keyVersion,
      key: access.active.key,
    },
  });
  return {
    id,
    name: file.name,
    canEdit: file.canEdit,
    sheetId: access.sheetId,
    sheetTitle: tab.title,
    keyVersion: access.active.keyVersion,
    range,
    decoded: await sync.load(range),
    sync,
  };
}

/** Recheck policy and key version immediately before writing. Google's ACL is
 * still authoritative at Google; these checks are not atomic with its write. */
export async function assertWorkbookStillEditable(
  workbook: LoadedWorkbook,
): Promise<void> {
  const file = await loadWorkbook(workbook.id);
  if (!file.canEdit) throw new WorkspaceRequestError(403);
  const access = WorkbookEncryptionAccessResponseSchema.parse(
    await workspaceRequest(`/workbooks/${workbook.id}/encryption`),
  );
  if (
    access.rotationPending ||
    access.pendingRotation ||
    access.activeKeyVersion !== workbook.keyVersion
  )
    throw new Error("Reload required after workbook key rotation");
}
