import { UniverSheetsCorePreset } from "@univerjs/preset-sheets-core";
import UniverPresetSheetsCoreEnUS from "@univerjs/preset-sheets-core/locales/en-US";
import {
  createUniver,
  LocaleType,
  ThemeService,
  type FUniver,
} from "@univerjs/presets";
import { SheetCoreError, type EditorCell } from "@zerosheet/sheet-core";
import { Columns3, Eraser, LockKeyhole, Save, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "./components/ui/button.js";
import { useTheme } from "./components/theme-provider.js";
import {
  assertWorkbookStillEditable,
  type LoadedWorkbook,
} from "./workbook-editor-session.js";
import { workspaceError } from "./workspace-client.js";
import "@univerjs/preset-sheets-core/lib/index.css";

/** Explicit Save gives users time to choose which cells to protect. Automatically
 * uploading while they type could disclose plaintext before that decision. */
export function EncryptedSheetEditor({
  workbook,
  onDirtyChange,
  onBusyChange,
  interactionBlocked = false,
}: {
  workbook: LoadedWorkbook;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
  interactionBlocked?: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const api = useRef<FUniver | null>(null);
  const theme = useRef<ThemeService | null>(null);
  const protection = useRef(workbook.decoded.protection.clone());
  const revision = useRef(0);
  const saving = useRef(false);
  const active = useRef(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [protectedCells, setProtectedCells] = useState(protection.current.size);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const { resolvedTheme } = useTheme();
  const initialTheme = useRef(resolvedTheme);
  const blocked = useRef(interactionBlocked);
  blocked.current = interactionBlocked;
  const rows = workbook.range.endRow + 1;
  const columns = workbook.range.endColumn + 1;

  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    theme.current?.setDarkMode(resolvedTheme === "dark");
  }, [resolvedTheme]);
  useEffect(() => {
    // Sharing/rotation uses the persisted snapshot. Freeze edits while the
    // modal is open, including keyboard shortcuts reaching the background.
    api.current
      ?.getActiveWorkbook()
      ?.setEditable(workbook.canEdit && !interactionBlocked);
  }, [interactionBlocked, workbook.canEdit]);
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  useEffect(() => {
    if (!container.current) return;
    active.current = true;
    protection.current = workbook.decoded.protection.clone();
    const instance = createUniver({
      locale: LocaleType.EN_US,
      darkMode: initialTheme.current === "dark",
      locales: { [LocaleType.EN_US]: UniverPresetSheetsCoreEnUS },
      presets: [
        UniverSheetsCorePreset({
          container: container.current,
          header: false,
          toolbar: false,
          contextMenu: false,
          footer: false,
        }),
      ],
    });
    api.current = instance.univerAPI;
    // Update the theme in place: recreating the canvas would discard unsaved edits.
    theme.current = instance.univer.__getInjector().get(ThemeService);
    const cellData: Record<
      number,
      Record<number, { v?: string | number | boolean | null; f?: string }>
    > = {};
    workbook.decoded.cells.forEach((row, r) => {
      cellData[r] = {};
      row.forEach((cell, c) => {
        cellData[r]![c] = cell.formula
          ? { f: cell.formula }
          : { v: cell.value };
      });
    });
    const sheet = instance.univerAPI.createWorkbook({
      id: workbook.id,
      name: workbook.name,
      sheetOrder: [workbook.sheetId],
      sheets: {
        [workbook.sheetId]: {
          id: workbook.sheetId,
          name: workbook.sheetTitle,
          rowCount: rows,
          columnCount: columns,
          cellData,
        },
      },
    });
    sheet.setEditable(workbook.canEdit && !blocked.current);
    const markDirty = () => {
      revision.current += 1;
      setDirty(true);
      setMessage("");
    };
    // Inline text may not emit SheetValueChanged until Enter/blur. Guard it as
    // unsaved immediately so navigation cannot discard a half-entered cell.
    const typing = (event: KeyboardEvent) => {
      if (
        workbook.canEdit &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        (event.key.length === 1 ||
          event.key === "Backspace" ||
          event.key === "Delete")
      )
        markDirty();
    };
    const element = container.current;
    element.addEventListener("keydown", typing, true);
    const changes = instance.univerAPI.addEvent(
      instance.univerAPI.Event.SheetValueChanged,
      markDirty,
    );
    // Structural changes are not persisted by a values-only adapter. Block them
    // rather than show rows/tabs that disappear after reopening the workbook.
    const structure = instance.univerAPI.onBeforeCommandExecute((command) => {
      if (
        /^sheet\.mutation\.(?:insert-|remove-(?:rows|col|sheet)|move-(?:range|rows|columns)|set-worksheet-(?:name|order|row-count|column-count))/u.test(
          command.id,
        )
      ) {
        setError(
          "Adding, moving, or removing rows, columns, and tabs is not supported in this editor yet.",
        );
        throw new Error("Unsupported workbook structure change");
      }
    });
    return () => {
      active.current = false;
      element.removeEventListener("keydown", typing, true);
      changes.dispose();
      structure.dispose();
      instance.univerAPI.dispose();
      api.current = null;
      theme.current = null;
    };
  }, [workbook, rows, columns]);

  function protect(mode: "selection" | "columns" | "remove") {
    if (!workbook.canEdit || saving.current || blocked.current) return;
    const selection = api.current
      ?.getActiveWorkbook()
      ?.getActiveSheet()
      .getActiveRange()
      ?.getRange();
    if (!selection) {
      setError("Select cells in the grid first.");
      return;
    }
    try {
      if (mode === "columns")
        protection.current.protectColumns({
          startColumn: selection.startColumn,
          endColumn: selection.endColumn,
          rowCount: rows,
        });
      else if (mode === "selection") protection.current.protectRange(selection);
      else protection.current.unprotectRange(selection);
      setProtectedCells(protection.current.size);
      revision.current += 1;
      setDirty(true);
      setError("");
      setMessage("");
    } catch (cause) {
      setError(workspaceError(cause));
    }
  }

  async function save() {
    const editor = api.current?.getActiveWorkbook();
    if (!editor || !workbook.canEdit || saving.current || blocked.current)
      return;
    saving.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      // Include text still being typed in the active cell before taking the
      // immutable save snapshot. Later edits stay dirty until their own save.
      await editor.endEditingAsync(true);
      const data = editor.getActiveSheet().getRange(0, 0, rows, columns);
      const cells = editorCells(data.getValues(), data.getFormulas());
      const snapshotProtection = protection.current.clone();
      const savedRevision = revision.current;
      await assertWorkbookStillEditable(workbook);
      await workbook.sync.save({
        range: workbook.range,
        cells,
        protection: snapshotProtection,
      });
      if (active.current) {
        const caughtUp = revision.current === savedRevision;
        setDirty(!caughtUp);
        setMessage(
          caughtUp
            ? "Saved to Google Drive"
            : "Saved earlier changes. New edits are still unsaved.",
        );
      }
    } catch (cause) {
      if (active.current) setError(workspaceError(cause));
    } finally {
      saving.current = false;
      if (active.current) setBusy(false);
    }
  }

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  });

  return (
    <section className="mt-5" aria-label="Workbook editor">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-y py-4">
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={!workbook.canEdit || busy}
            onClick={() => protect("selection")}
          >
            <LockKeyhole />
            Protect selection
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!workbook.canEdit || busy}
            onClick={() => protect("columns")}
          >
            <Columns3 />
            Protect columns
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!workbook.canEdit || busy}
            onClick={() => protect("remove")}
          >
            <Eraser />
            Remove protection
          </Button>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-xs text-muted-foreground" role="status">
            {workbook.canEdit
              ? busy
                ? "Saving…"
                : dirty
                  ? "Unsaved changes"
                  : message || "Up to date"
              : "View only"}
          </span>
          <Button
            size="sm"
            disabled={!workbook.canEdit || busy}
            onClick={() => void save()}
          >
            <Save />
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
      {error && (
        <p role="alert" className="mb-4 border border-destructive p-4 text-sm">
          {error} Your changes remain in this page; do not close it before
          saving.
        </p>
      )}
      <div className="univer-container" ref={container} />
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>{workbook.sheetTitle}</span>
        <span className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4" />
          {protectedCells} protected cells
        </span>
      </div>
      <p className="mt-4 text-xs leading-5 text-muted-foreground">
        Choose protection before saving. Unprotected cells are visible to
        Google. This version saves values, formulas, and protection in the first{" "}
        {rows} rows and {columns} columns of this tab. Other cells stay
        unchanged; formatting and additional tabs are not editable here yet.
      </p>
    </section>
  );
}

/** Normalize blanks; never serialize arbitrary rich editor objects into cells. */
export function editorCells(
  values: readonly (readonly unknown[])[],
  formulas: readonly (readonly string[])[],
): EditorCell[][] {
  return values.map((row, r) =>
    row.map((value, c) => {
      const formula = formulas[r]?.[c];
      if (formula) return { value: null, formula };
      if (value === null || value === undefined) return { value: null };
      if (
        typeof value === "string" ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value))
      )
        return { value };
      throw new SheetCoreError("SHEET_INVALID_CELL");
    }),
  );
}
