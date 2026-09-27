/** Small, explicit routes keep folder links bookmarkable without mixing a
 * folder ID with an editor ID. Unknown paths never trigger a resource request. */
export type WorkspaceRoute =
  | { kind: "home" }
  | { kind: "recovery" }
  | { kind: "editor"; id: string }
  | {
      kind: "collection";
      folderId: string | null;
      shared: boolean;
      create: boolean;
    }
  | { kind: "missing" };

const uuid =
  "([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})";
const editorPath = new RegExp(`^/workbooks/${uuid}$`, "iu");
const folderPath = new RegExp(`^/workbooks/folders/${uuid}$`, "iu");

export function workspaceRoute(pathname: string): WorkspaceRoute {
  const path = pathname.replace(/\/+$/u, "") || "/";
  if (path === "/" || path === "/home") return { kind: "home" };
  if (path === "/recovery-access") return { kind: "recovery" };
  if (["/workbooks", "/workbooks/new", "/shared-with-me"].includes(path)) {
    return {
      kind: "collection",
      folderId: null,
      shared: path === "/shared-with-me",
      create: path === "/workbooks/new",
    };
  }
  const folder = folderPath.exec(path)?.[1];
  if (folder)
    return {
      kind: "collection",
      folderId: folder,
      shared: false,
      create: false,
    };
  const id = editorPath.exec(path)?.[1];
  return id ? { kind: "editor", id } : { kind: "missing" };
}

export function workbookFolderPath(id: string | null): string {
  return id ? `/workbooks/folders/${id}` : "/workbooks";
}
