import {
  EncryptionIdentityResponseSchema,
  WorkspaceResponseSchema,
  WorkspaceWorkbookSchema,
  type WorkspaceFolder,
  type WorkspaceWorkbook,
} from "@zerosheet/contracts";
import { GoogleStorageError } from "@zerosheet/google-storage";
import { ZeroSheetCryptoError } from "@zerosheet/crypto";
import { SheetCoreError } from "@zerosheet/sheet-core";

/** All product requests stay same-origin. Only reviewed operation helpers may
 * talk to Google; this module neither handles nor logs OAuth credentials. */
export async function workspaceRequest(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<unknown> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new WorkspaceRequestError(response.status);
  return response.status === 204 ? undefined : response.json();
}
export class WorkspaceRequestError extends Error {
  constructor(public readonly status: number) {
    super("Workspace request failed");
  }
}
export async function loadWorkspace(after?: string) {
  return WorkspaceResponseSchema.parse(
    await workspaceRequest(
      `/workspace${after ? `?after=${encodeURIComponent(after)}` : ""}`,
    ),
  );
}
export async function loadWorkbook(id: string) {
  return WorkspaceWorkbookSchema.parse(
    await workspaceRequest(`/workspace/workbooks/${encodeURIComponent(id)}`),
  );
}
export async function hasEncryptionIdentity(): Promise<boolean> {
  try {
    EncryptionIdentityResponseSchema.parse(
      await workspaceRequest("/encryption/identities/me"),
    );
    return true;
  } catch (error) {
    // This endpoint uses 409 only when no current identity exists. A network,
    // login, or schema failure must not offer to replace an existing identity.
    if (error instanceof WorkspaceRequestError && error.status === 409)
      return false;
    throw error;
  }
}
/** The sync layer deliberately wraps transport failures in a safe sheet error.
 * Recover only our known error categories, never arbitrary provider bodies or
 * nested exception text, so the UI can distinguish login from retry failures. */
function actionableWorkspaceError(error: unknown): unknown {
  if (
    error instanceof SheetCoreError &&
    error.code === "SHEET_STORAGE_UNAVAILABLE" &&
    (error.cause instanceof GoogleStorageError ||
      error.cause instanceof WorkspaceRequestError)
  ) {
    return error.cause;
  }
  return error;
}

/** An unavailable API or malformed response cannot be fixed by signing in.
 * Offer that action only when the app session or Google authorization needs it. */
export function workspaceNeedsSignIn(failure: unknown): boolean {
  const error = actionableWorkspaceError(failure);
  return (
    (error instanceof WorkspaceRequestError && error.status === 401) ||
    (error instanceof GoogleStorageError &&
      (error.code === "GOOGLE_AUTH_EXPIRED" ||
        error.code === "GOOGLE_CONNECTION_REQUIRED"))
  );
}

export function workspaceError(failure: unknown): string {
  const error = actionableWorkspaceError(failure);
  if (error instanceof WorkspaceRequestError) {
    if (error.status === 401)
      return "Your session expired. Sign in again to continue.";
    if (error.status === 403 || error.status === 404)
      return "You no longer have access to this workbook or folder.";
    if (error.status === 409)
      return "This action conflicts with existing setup. Refresh before retrying.";
  }
  if (error instanceof ZeroSheetCryptoError)
    // A locked in-memory session is different from incorrect words or a
    // damaged key envelope. Keep those safe categories distinct for recovery.
    return new ZeroSheetCryptoError(error.code).message;
  if (error instanceof SheetCoreError) return error.message;
  if (error instanceof GoogleStorageError) {
    if (workspaceNeedsSignIn(error))
      return "Google authorization is missing or expired. Sign in again to continue.";
    if (error.code === "GOOGLE_PERMISSION_DENIED")
      return "Google denied access. Check that Drive and Sheets APIs are enabled and that you have permission to this file.";
    // Reconstruct from the stable code instead of rendering any original error
    // message/cause, which may have been enriched with provider details.
    return new GoogleStorageError(error.code).message;
  }
  return "This action could not be completed. Your unsaved changes have not been marked as saved. Please retry.";
}

/** Search is intentionally over loaded, authorized metadata only. */
export function visibleWorkbooks(
  workbooks: readonly WorkspaceWorkbook[],
  input: {
    userId: string;
    folderId: string | null;
    search: string;
    filter: "all" | "mine" | "shared";
    sort: "newest" | "oldest" | "name" | "name-desc";
    allFolders?: boolean;
  },
) {
  return workbooks
    .filter(
      (file) =>
        (input.search
          ? file.name.toLowerCase().includes(input.search.toLowerCase())
          : input.allFolders || file.folderId === input.folderId) &&
        (input.filter === "all" ||
          (input.filter === "mine"
            ? file.createdBy === input.userId
            : file.createdBy !== input.userId)),
    )
    .sort((a, b) =>
      input.sort === "name"
        ? a.name.localeCompare(b.name)
        : input.sort === "name-desc"
          ? b.name.localeCompare(a.name)
          : input.sort === "oldest"
            ? a.createdAt.localeCompare(b.createdAt)
            : b.createdAt.localeCompare(a.createdAt),
    );
}
export function folderTrail(
  folders: readonly WorkspaceFolder[],
  id: string | null,
): WorkspaceFolder[] {
  const result: WorkspaceFolder[] = [];
  const visited = new Set<string>();
  while (id && !visited.has(id)) {
    visited.add(id);
    const folder = folders.find((item) => item.id === id);
    if (!folder) break;
    result.unshift(folder);
    id = folder.parentId;
  }
  return result;
}
