import { useEffect, useState } from "react";
import {
  OrganizationResponseSchema,
  WorkbookResponseSchema,
  type AuthenticatedUser,
  type WorkspaceResponse,
  type WorkspaceWorkbook,
} from "@zerosheet/contracts";
import {
  ChevronRight,
  ArrowDownUp,
  ChevronDown,
  FolderPlus,
  LayoutGrid,
  List,
  LoaderCircle,
  LockKeyhole,
  Plus,
  RefreshCw,
  Search,
  Sheet,
} from "lucide-react";
import { Button } from "./components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog.js";
import {
  folderTrail,
  loadWorkspace,
  visibleWorkbooks,
  workspaceError,
  workspaceRequest,
} from "./workspace-client.js";
import {
  initializeEncryptedWorkbook,
  recoverEncryptionIdentity,
} from "./secure-workbook.js";
import {
  WorkbookFolderItem,
  WorkbookItem,
} from "./components/workbook-items.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu.js";
import { workbookFolderPath } from "./workspace-routes.js";

export interface RecoverySession {
  readonly unlocked: boolean;
  unlock: (phrase: string) => void;
  use<T>(operation: (phrase: string) => Promise<T>): Promise<T>;
}

/** ZeroDrive's storage layout: modest header, real file list, square controls,
 * search/filter/sort, and list/grid views. No sample files or connection panel. */
export function WorkbookHome({
  user,
  recovery,
  navigate,
  folderId = null,
  shared = false,
  createOnOpen = false,
}: {
  user: AuthenticatedUser;
  recovery: RecoverySession;
  navigate: (path: string) => void;
  folderId?: string | null;
  shared?: boolean;
  createOnOpen?: boolean;
}) {
  const [data, setData] = useState<WorkspaceResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "mine" | "shared">(
    shared ? "shared" : "all",
  );
  const [sort, setSort] = useState<"newest" | "oldest" | "name" | "name-desc">(
    "newest",
  );
  const [view, setView] = useState<"list" | "grid">("grid");
  const [dialog, setDialog] = useState<"workbook" | "folder" | null>(
    createOnOpen ? "workbook" : null,
  );
  const [moving, setMoving] = useState<WorkspaceWorkbook | null>(null);
  const [targetFolder, setTargetFolder] = useState("");
  const [name, setName] = useState("");
  const [organizationId, setOrganizationId] = useState("");
  const [organizationName, setOrganizationName] = useState("Personal");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void loadWorkspace()
      .then((result) => {
        if (active) {
          setData(result);
          setOrganizationId(
            (current) => current || result.organizations[0]?.id || "",
          );
        }
      })
      .catch((cause: unknown) => {
        // Do not leave a formerly authorized list visible after a failed refresh.
        if (active) {
          setData(null);
          setError(workspaceError(cause));
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [refresh]);

  // URLs preserve folder navigation through Browser Back and editor return.
  function openFolder(id: string | null) {
    setSearch("");
    navigate(workbookFolderPath(id));
  }
  function closeDialog() {
    if (busy) return;
    setDialog(null);
    if (createOnOpen) navigate("/workbooks");
  }

  function openDialog(kind: "workbook" | "folder") {
    setName("");
    setActionError("");
    setOrganizationId(data?.organizations[0]?.id ?? "");
    setDialog(kind);
  }

  async function create() {
    if (!name.trim() || busy || !data || loading) return;
    setBusy(true);
    setActionError("");
    try {
      if (dialog === "folder") {
        await workspaceRequest("/workspace/folders", "POST", {
          name: name.trim(),
          parentId: folderId,
        });
        setDialog(null);
        setRefresh((value) => value + 1);
        return;
      }
      await recovery.use(async (phrase) => {
        // Validate/unlock the existing identity before creating any server or
        // Google resource. A bad phrase must not litter the user's Drive.
        const identity = await recoverEncryptionIdentity(phrase);
        let organization = organizationId;
        if (!organization) {
          const created = OrganizationResponseSchema.parse(
            await workspaceRequest("/organizations", "POST", {
              name: organizationName.trim(),
            }),
          );
          organization = created.id;
          setOrganizationId(created.id);
        }
        const workbook = WorkbookResponseSchema.parse(
          await workspaceRequest(
            `/organizations/${organization}/workbooks`,
            "POST",
            { name: name.trim() },
          ),
        );
        // A draft stays discoverable if Google/envelope setup fails. The file's
        // editor offers Finish setup, instead of pretending a save succeeded.
        try {
          await initializeEncryptedWorkbook({
            workbookId: workbook.id,
            title: workbook.name,
            creatorPublicKey: identity.publicKey,
          });
          if (folderId)
            await workspaceRequest(
              `/workspace/workbooks/${workbook.id}/folder`,
              "PUT",
              { folderId },
            );
        } catch {
          setDialog(null);
          navigate(`/workbooks/${workbook.id}`);
          return;
        }
        setDialog(null);
        navigate(`/workbooks/${workbook.id}`);
      });
    } catch (cause) {
      setActionError(workspaceError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function move() {
    if (!moving || busy) return;
    setBusy(true);
    setActionError("");
    try {
      await workspaceRequest(
        `/workspace/workbooks/${moving.id}/folder`,
        "PUT",
        { folderId: targetFolder || null },
      );
      setMoving(null);
      setRefresh((value) => value + 1);
    } catch (cause) {
      setActionError(workspaceError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function loadMore() {
    if (!data?.nextCursor || loading) return;
    setLoading(true);
    setError("");
    try {
      const page = await loadWorkspace(data.nextCursor);
      setData({ ...page, workbooks: [...data.workbooks, ...page.workbooks] });
    } catch (cause) {
      setError(workspaceError(cause));
    } finally {
      setLoading(false);
    }
  }

  const files = visibleWorkbooks(data?.workbooks ?? [], {
    userId: user.id,
    folderId,
    search,
    filter,
    sort,
    allFolders: shared,
  });
  const folders = (shared ? [] : (data?.folders ?? [])).filter((folder) =>
    search
      ? folder.name.toLowerCase().includes(search.toLowerCase())
      : folder.parentId === folderId,
  );
  const trail = folderTrail(data?.folders ?? [], folderId);
  const folderMissing =
    !!data &&
    !!folderId &&
    !data.folders.some((folder) => folder.id === folderId);

  function renderWorkbook(file: WorkspaceWorkbook, grid: boolean) {
    return (
      <WorkbookItem
        key={file.id}
        file={file}
        grid={grid}
        userId={user.id}
        onOpen={() => navigate(`/workbooks/${file.id}`)}
        onMove={() => {
          setActionError("");
          setTargetFolder(file.folderId ?? "");
          setMoving(file);
        }}
      />
    );
  }

  return (
    <main className="mx-auto max-w-6xl space-y-6 px-6 pb-20 pt-6">
      <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
        <div className="max-w-3xl space-y-2">
          <h1 className="text-2xl tracking-tight">
            {shared ? "Shared with me" : "Workbooks"}
          </h1>
          <p className="text-sm font-light leading-relaxed text-muted-foreground">
            Your spreadsheets, in one place. Open a workbook to edit and protect
            cells before saving to Google Drive.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 sm:justify-end lg:shrink-0 lg:pt-2">
          {!shared && (
            <>
              <Button
                size="sm"
                onClick={() => openDialog("workbook")}
                disabled={!data || loading || folderMissing}
              >
                <Plus />
                New workbook
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => openDialog("folder")}
                disabled={!data || loading || folderMissing}
              >
                <FolderPlus />
                New folder
              </Button>
            </>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => setRefresh(refresh + 1)}
            disabled={loading}
          >
            <RefreshCw className={loading ? "animate-spin" : ""} />
            Refresh
          </Button>
        </div>
      </div>
      <div className="flex flex-col gap-3 pb-3 lg:flex-row lg:items-center lg:justify-between">
        <label className="flex items-center gap-2 border px-3 py-2 sm:w-80">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            className="w-full bg-transparent text-sm outline-none"
            aria-label="Search workbooks"
            placeholder="Search workbooks…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          {!shared &&
            (["all", "mine", "shared"] as const).map((value) => (
              <button
                key={value}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
                className={`border px-3 py-1.5 text-xs ${filter === value ? "border-foreground bg-muted font-semibold" : "text-muted-foreground hover:bg-muted/60"}`}
              >
                {value === "all"
                  ? "All"
                  : value === "mine"
                    ? "My workbooks"
                    : "Shared with me"}
              </button>
            ))}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="flex items-center gap-2 border px-3 py-1.5 text-xs"
                aria-label="Sort workbooks"
              >
                <ArrowDownUp className="h-3.5 w-3.5" />
                {
                  {
                    newest: "Newest",
                    oldest: "Oldest",
                    name: "Name A–Z",
                    "name-desc": "Name Z–A",
                  }[sort]
                }
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {(
                [
                  ["newest", "Newest first"],
                  ["oldest", "Oldest first"],
                  ["name", "Name A–Z"],
                  ["name-desc", "Name Z–A"],
                ] as const
              ).map(([value, label]) => (
                <DropdownMenuItem key={value} onSelect={() => setSort(value)}>
                  {label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="flex border">
            <button
              aria-label="Grid view"
              aria-pressed={view === "grid"}
              className={`p-2 ${view === "grid" ? "bg-muted" : ""}`}
              onClick={() => setView("grid")}
            >
              <LayoutGrid className="h-4 w-4" />
            </button>
            <button
              aria-label="List view"
              aria-pressed={view === "list"}
              className={`border-l p-2 ${view === "list" ? "bg-muted" : ""}`}
              onClick={() => setView("list")}
            >
              <List className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
      {folderId && (
        <nav
          aria-label="Folder breadcrumb"
          className="flex flex-wrap items-center gap-2 text-xs"
        >
          <button
            onClick={() => {
              openFolder(null);
            }}
          >
            All workbooks
          </button>
          {trail.map((folder) => (
            <span key={folder.id} className="flex items-center gap-2">
              <ChevronRight className="h-3 w-3" />
              <button
                onClick={() => {
                  openFolder(folder.id);
                }}
              >
                {folder.name}
              </button>
            </span>
          ))}
        </nav>
      )}
      {error && (
        <p role="alert" className="border border-destructive p-4 text-sm">
          {error}
        </p>
      )}
      {loading && !data && (
        <p
          role="status"
          className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"
        >
          <LoaderCircle className="h-4 w-4 animate-spin" />
          Loading your workbooks…
        </p>
      )}
      {folderMissing ? (
        <p role="alert" className="border p-5 text-sm">
          This folder is not available.{" "}
          <button className="underline" onClick={() => openFolder(null)}>
            Back to all workbooks
          </button>
        </p>
      ) : (
        data && (
          <>
            {/* Match ZeroDrive's borderless icon tiles and compact table. Created
              is the available timestamp; it must not be relabeled Modified. */}
            {view === "grid" ? (
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
                {folders.map((folder) => (
                  <WorkbookFolderItem
                    key={folder.id}
                    folder={folder}
                    grid
                    navigate={(path) => {
                      setSearch("");
                      navigate(path);
                    }}
                  />
                ))}
                {files.map((file) => renderWorkbook(file, true))}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table
                  aria-label="Workbooks and folders"
                  className="w-full table-fixed border-collapse text-sm"
                >
                  <thead>
                    <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="py-2.5 pr-3 font-medium">Name</th>
                      <th className="hidden w-40 py-2.5 pr-3 font-medium sm:table-cell">
                        Access / type
                      </th>
                      <th className="hidden w-32 py-2.5 pr-3 font-medium md:table-cell">
                        Created
                      </th>
                      <th className="w-10">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {folders.map((folder) => (
                      <WorkbookFolderItem
                        key={folder.id}
                        folder={folder}
                        grid={false}
                        navigate={(path) => {
                          setSearch("");
                          navigate(path);
                        }}
                      />
                    ))}
                    {files.map((file) => renderWorkbook(file, false))}
                  </tbody>
                </table>
              </div>
            )}
            {!files.length && !folders.length && (
              <section className="border px-6 py-16 text-center">
                <Sheet className="mx-auto mb-4 h-8 w-8 text-muted-foreground" />
                <h2 className="text-lg font-medium">
                  {search
                    ? "No matching workbooks"
                    : shared
                      ? "No shared workbooks yet"
                      : "No workbooks here yet"}
                </h2>
                <p className="mx-auto mt-3 max-w-lg text-sm text-muted-foreground">
                  {search
                    ? "Try another name, or load more workbooks below."
                    : shared
                      ? "Workbooks shared with your account will appear here when access is ready."
                      : "Create a workbook to start. Your saved sheets will appear here, ready to reopen."}
                </p>
                {!search && !shared && (
                  <Button
                    className="mt-6"
                    onClick={() => openDialog("workbook")}
                  >
                    <Plus />
                    Create workbook
                  </Button>
                )}
              </section>
            )}
            {data.nextCursor && (
              <div className="text-center">
                <Button
                  variant="outline"
                  disabled={loading}
                  onClick={() => void loadMore()}
                >
                  {loading ? "Loading…" : "Load more workbooks"}
                </Button>
                <p className="mt-2 text-xs text-muted-foreground">
                  Search and sorting apply to loaded workbooks.
                </p>
              </div>
            )}
          </>
        )
      )}
      <p className="flex items-start gap-2 border border-dashed p-4 text-xs leading-5 text-muted-foreground">
        <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0" />
        Only cells you protect are encrypted. Workbook and folder names remain
        visible metadata. Folders organize your list; they do not change sharing
        permissions.
      </p>

      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {dialog === "folder" ? "New folder" : "New workbook"}
            </DialogTitle>
            <DialogDescription>
              {dialog === "folder"
                ? "Organize your workbooks without moving Google files or changing access."
                : "Create a spreadsheet in your Google Drive with a recoverable encryption key."}
            </DialogDescription>
          </DialogHeader>
          {/* Recovery is completed on the first page. This dialog only asks
              about the new workbook, never repeats account/key setup. */}
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <label className="block text-sm">
              Name
              <input
                autoFocus
                required
                maxLength={200}
                className="mt-2 w-full border bg-background p-3"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={
                  dialog === "folder" ? "Projects" : "Untitled workbook"
                }
              />
            </label>
            {dialog === "workbook" &&
              (data?.organizations.length ? (
                <label className="block text-sm">
                  Workspace
                  <select
                    className="mt-2 w-full border bg-background p-3"
                    value={organizationId}
                    onChange={(event) => setOrganizationId(event.target.value)}
                  >
                    {data.organizations.map((organization) => (
                      <option key={organization.id} value={organization.id}>
                        {organization.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <label className="block text-sm">
                  Workspace name
                  <input
                    required
                    maxLength={200}
                    className="mt-2 w-full border bg-background p-3"
                    value={organizationName}
                    onChange={(event) =>
                      setOrganizationName(event.target.value)
                    }
                  />
                  <span className="mt-2 block text-xs text-muted-foreground">
                    Your first workbook needs a workspace. You will be its
                    owner.
                  </span>
                </label>
              ))}
            {actionError && (
              <p role="alert" className="text-sm text-destructive">
                {actionError}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={closeDialog}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={busy || !name.trim() || loading || !data}
              >
                {busy ? "Creating…" : "Create"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={moving !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setMoving(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Move workbook</DialogTitle>
            <DialogDescription>
              Choose where {moving?.name} appears in your personal list.
            </DialogDescription>
          </DialogHeader>
          <select
            aria-label="Destination folder"
            className="border bg-background p-3 text-sm"
            value={targetFolder}
            onChange={(event) => setTargetFolder(event.target.value)}
          >
            <option value="">All workbooks</option>
            {data?.folders.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folderTrail(data.folders, folder.id)
                  .map((item) => item.name)
                  .join(" / ")}
              </option>
            ))}
          </select>
          {actionError && <p role="alert">{actionError}</p>}
          <Button disabled={busy} onClick={() => void move()}>
            {busy ? "Moving…" : "Move"}
          </Button>
        </DialogContent>
      </Dialog>
    </main>
  );
}

export { WorkbookItem } from "./components/workbook-items.js";
