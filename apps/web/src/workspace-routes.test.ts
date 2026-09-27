import { describe, expect, it } from "vitest";
import { workbookFolderPath, workspaceRoute } from "./workspace-routes.js";

const id = "a1000000-0000-4000-8000-000000000001";
/** Folder and editor routes share recovery but must never be confused. */
describe("workspace routes", () => {
  it("keeps the hub, file browser, create shortcut, and shared inbox separate", () => {
    expect(workspaceRoute("/")).toEqual({ kind: "home" });
    expect(workspaceRoute("/home/")).toEqual({ kind: "home" });
    expect(workspaceRoute("/workbooks")).toEqual({
      kind: "collection",
      folderId: null,
      shared: false,
      create: false,
    });
    expect(workspaceRoute("/workbooks/new")).toMatchObject({
      kind: "collection",
      create: true,
    });
    expect(workspaceRoute("/shared-with-me")).toMatchObject({
      kind: "collection",
      shared: true,
    });
    expect(workspaceRoute("/recovery-access")).toEqual({ kind: "recovery" });
  });
  it("round-trips folder URLs and rejects malformed editor links", () => {
    expect(workspaceRoute(workbookFolderPath(id))).toEqual({
      kind: "collection",
      folderId: id,
      shared: false,
      create: false,
    });
    expect(workspaceRoute(`/workbooks/${id}`)).toEqual({ kind: "editor", id });
    expect(workbookFolderPath(null)).toBe("/workbooks");
    for (const path of [
      "/workbooks/not-an-id",
      "/workbooks/folders/invalid",
      `/workbooks/${id}/unrecognized`,
    ])
      expect(workspaceRoute(path)).toEqual({ kind: "missing" });
  });
});
