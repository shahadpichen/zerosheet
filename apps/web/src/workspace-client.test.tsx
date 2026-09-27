import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { WorkspaceWorkbook } from "@zerosheet/contracts";
import { GoogleStorageError } from "@zerosheet/google-storage";
import { SheetCoreError } from "@zerosheet/sheet-core";
import { ZeroSheetCryptoError } from "@zerosheet/crypto";
import { WorkbookItem } from "./WorkbookHome.js";
import {
  folderTrail,
  visibleWorkbooks,
  workspaceError,
  workspaceNeedsSignIn,
  WorkspaceRequestError,
} from "./workspace-client.js";

const userId = "a1000000-0000-4000-8000-000000000001";
const file: WorkspaceWorkbook = {
  id: "a1000000-0000-4000-8000-000000000002",
  organizationId: "a1000000-0000-4000-8000-000000000003",
  name: "Budget",
  createdBy: userId,
  createdAt: "2026-09-26T10:00:00.000Z",
  folderId: null,
  ready: true,
  canEdit: true,
  canShare: true,
};

/** Opening and saving wrap Google failures in a sheet error. These assertions
 * prevent the wrapper from sending users into an unrelated login loop. */
describe("workbook recovery actions", () => {
  it("distinguishes a locked recovery session from an incorrect phrase", () => {
    expect(
      workspaceError(new ZeroSheetCryptoError("RECOVERY_ACCESS_REQUIRED")),
    ).toBe("Enter the recovery phrase for this account before continuing.");
    expect(
      workspaceError(new ZeroSheetCryptoError("RECOVERY_PHRASE_MISMATCH")),
    ).toBe("This recovery phrase cannot open the encrypted private key.");
    expect(
      workspaceNeedsSignIn(
        new ZeroSheetCryptoError("RECOVERY_ACCESS_REQUIRED"),
      ),
    ).toBe(false);
  });
  it.each(["GOOGLE_AUTH_EXPIRED", "GOOGLE_CONNECTION_REQUIRED"] as const)(
    "offers sign-in for %s, including wrapped failures",
    (code) => {
      const cause = new GoogleStorageError(code);
      const wrapped = new SheetCoreError("SHEET_STORAGE_UNAVAILABLE", {
        cause,
      });
      expect(workspaceNeedsSignIn(cause)).toBe(true);
      expect(workspaceNeedsSignIn(wrapped)).toBe(true);
      expect(workspaceError(wrapped)).toContain("Sign in again");
    },
  );
  it.each([
    "GOOGLE_INVALID_RESPONSE",
    "GOOGLE_UNAVAILABLE",
    "GOOGLE_RATE_LIMITED",
    "GOOGLE_PERMISSION_DENIED",
    "GOOGLE_RESOURCE_NOT_FOUND",
  ] as const)("does not offer sign-in for %s", (code) => {
    const cause = new GoogleStorageError(code);
    const wrapped = new SheetCoreError("SHEET_STORAGE_UNAVAILABLE", { cause });
    expect(workspaceNeedsSignIn(cause)).toBe(false);
    expect(workspaceNeedsSignIn(wrapped)).toBe(false);
    expect(workspaceError(wrapped)).toBe(workspaceError(cause));
    expect(workspaceError(wrapped)).not.toContain("Sign in again");
  });
  it("recognizes an expired app session but not a forbidden workbook", () => {
    expect(workspaceNeedsSignIn(new WorkspaceRequestError(401))).toBe(true);
    expect(workspaceNeedsSignIn(new WorkspaceRequestError(403))).toBe(false);
    const wrapped = new SheetCoreError("SHEET_STORAGE_UNAVAILABLE", {
      cause: new WorkspaceRequestError(401),
    });
    expect(workspaceNeedsSignIn(wrapped)).toBe(true);
    expect(workspaceError(wrapped)).toContain("Your session expired");
  });
  it("does not expose arbitrary cause text or reinterpret non-storage errors", () => {
    const unknown = new SheetCoreError("SHEET_STORAGE_UNAVAILABLE", {
      cause: new Error("private provider details"),
    });
    expect(workspaceError(unknown)).toBe(unknown.message);
    expect(workspaceNeedsSignIn(unknown)).toBe(false);
    const corrupt = new SheetCoreError("SHEET_CORRUPT_CIPHERTEXT", {
      cause: new GoogleStorageError("GOOGLE_AUTH_EXPIRED"),
    });
    expect(workspaceError(corrupt)).toBe(corrupt.message);
    expect(workspaceNeedsSignIn(corrupt)).toBe(false);
  });
});
describe("workbook browser", () => {
  it("renders each workbook as a real editor link, without demo data", () => {
    const markup = renderToStaticMarkup(
      <WorkbookItem
        file={file}
        userId={userId}
        grid={false}
        onOpen={() => {}}
        onMove={() => {}}
      />,
    );
    expect(markup).toContain(`/workbooks/${file.id}`);
    expect(markup).toContain("Budget");
    expect(markup).not.toContain("Acme");
  });
  it("filters owned/shared files, folders and search without changing source data", () => {
    const shared = {
      ...file,
      id: "other",
      name: "Accounts",
      createdBy: "other",
      folderId: "folder",
    };
    const files = [file, shared];
    const filter = {
      userId,
      folderId: null,
      search: "",
      filter: "all" as const,
      sort: "name" as const,
    };
    expect(visibleWorkbooks(files, filter)).toEqual([file]);
    expect(
      visibleWorkbooks(files, { ...filter, filter: "shared", search: "acc" }),
    ).toEqual([shared]);
    expect(files).toEqual([file, shared]);
  });
  it("builds nested breadcrumbs and terminates even with malformed cycles", () => {
    const folders = [
      { id: "a", name: "Parent", parentId: null },
      { id: "b", name: "Child", parentId: "a" },
    ];
    expect(folderTrail(folders, "b").map((folder) => folder.name)).toEqual([
      "Parent",
      "Child",
    ]);
    expect(
      folderTrail([{ id: "a", name: "Bad", parentId: "a" }], "a"),
    ).toHaveLength(1);
  });
  it("includes shared workbooks across personal folders only in the shared inbox", () => {
    const shared = {
      ...file,
      id: "shared",
      createdBy: "other",
      folderId: "projects",
    };
    const input = {
      userId,
      folderId: null,
      search: "",
      filter: "shared" as const,
      sort: "newest" as const,
    };
    expect(visibleWorkbooks([file, shared], input)).toEqual([]);
    expect(
      visibleWorkbooks([file, shared], { ...input, allFolders: true }),
    ).toEqual([shared]);
  });
  it("sorts in both directions without mutating loaded metadata", () => {
    const earlier = {
      ...file,
      id: "older",
      name: "Accounts",
      createdAt: "2026-08-01T00:00:00.000Z",
    };
    const input = {
      userId,
      folderId: null,
      search: "",
      filter: "all" as const,
      sort: "oldest" as const,
    };
    const files = [file, earlier];
    expect(visibleWorkbooks(files, input)).toEqual([earlier, file]);
    expect(visibleWorkbooks(files, { ...input, sort: "name-desc" })).toEqual([
      file,
      earlier,
    ]);
    expect(files).toEqual([file, earlier]);
  });
});
