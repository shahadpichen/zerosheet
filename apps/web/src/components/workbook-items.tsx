import type { WorkspaceFolder, WorkspaceWorkbook } from "@zerosheet/contracts";
import { FolderInput } from "lucide-react";
import { Button } from "./ui/button.js";
import { WorkspaceLink } from "./workspace-link.js";
import { workbookFolderPath } from "../workspace-routes.js";

/** Reuse ZeroDrive's existing folder/spreadsheet assets. Both views render
 * the same metadata; changing views cannot change permissions or protection. */
export function WorkbookFolderItem({
  folder,
  grid,
  navigate,
}: {
  folder: WorkspaceFolder;
  grid: boolean;
  navigate: (path: string) => void;
}) {
  const link = (
    <WorkspaceLink
      href={workbookFolderPath(folder.id)}
      navigate={navigate}
      title={folder.name}
      className={
        grid
          ? "flex min-w-0 flex-col items-center gap-2 p-4 hover:bg-muted/50"
          : "flex min-w-0 items-center gap-2.5 py-2.5"
      }
    >
      <img
        src="/folder.png"
        alt=""
        className={grid ? "h-12 w-12" : "h-5 w-5 shrink-0"}
      />
      <span
        className={`w-full truncate text-sm font-medium ${grid ? "text-center" : ""}`}
      >
        {folder.name}
      </span>
    </WorkspaceLink>
  );
  if (grid) return link;
  return (
    <tr className="border-b hover:bg-muted/50">
      <td className="pr-3">{link}</td>
      <td className="hidden py-2.5 pr-3 text-muted-foreground sm:table-cell">
        Folder
      </td>
      <td className="hidden py-2.5 pr-3 text-muted-foreground md:table-cell">
        —
      </td>
      <td className="w-10" />
    </tr>
  );
}

/** Move is implemented; delete and rename are deliberately not decorative
 * menu items. New-tab links still work, while ordinary navigation retains keys. */
export function WorkbookItem({
  file,
  grid,
  userId,
  onOpen,
  onMove,
}: {
  file: WorkspaceWorkbook;
  grid: boolean;
  userId: string;
  onOpen: () => void;
  onMove: () => void;
}) {
  const status = !file.ready
    ? "Setup incomplete"
    : file.createdBy === userId
      ? "Owned by you"
      : file.canEdit
        ? "Shared · Can edit"
        : "Shared · View only";
  const moveButton = (
    <Button
      variant="ghost"
      size="icon"
      aria-label={`Move ${file.name}`}
      title={`Move ${file.name}`}
      onClick={onMove}
      className="h-7 w-7 text-muted-foreground"
    >
      <FolderInput />
    </Button>
  );
  const content = (
    <WorkspaceLink
      href={`/workbooks/${file.id}`}
      navigate={onOpen}
      title={`${file.name} — ${status}`}
      className={
        grid
          ? "flex min-w-0 flex-col items-center gap-2 p-4"
          : "flex min-w-0 items-center gap-2.5 py-2.5"
      }
    >
      <img
        src="/workbook.png"
        alt=""
        className={grid ? "h-12 w-12" : "h-5 w-5 shrink-0"}
      />
      <span className={`min-w-0 ${grid ? "w-full text-center" : "flex-1"}`}>
        <span className="block truncate text-sm font-medium">{file.name}</span>
        <span className="sr-only"> {status}</span>
        {!file.ready && (
          <span className="mt-1 block text-xs text-muted-foreground">
            Setup incomplete
          </span>
        )}
      </span>
      {grid && (
        <span className="text-xs text-muted-foreground">
          {new Date(file.createdAt).toLocaleDateString()}
        </span>
      )}
    </WorkspaceLink>
  );
  if (grid)
    return (
      <article className="group relative min-w-0 hover:bg-muted/50">
        {content}
        <div className="absolute right-1 top-1 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
          {moveButton}
        </div>
      </article>
    );
  return (
    <tr className="group border-b hover:bg-muted/50">
      <td className="pr-3">{content}</td>
      <td className="hidden py-2.5 pr-3 text-xs text-muted-foreground sm:table-cell">
        {status}
      </td>
      <td className="hidden py-2.5 pr-3 text-xs text-muted-foreground md:table-cell">
        {new Date(file.createdAt).toLocaleDateString()}
      </td>
      <td className="w-10 py-2.5 text-right">{moveButton}</td>
    </tr>
  );
}
