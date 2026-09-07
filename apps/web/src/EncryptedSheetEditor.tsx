import { UniverSheetsCorePreset } from "@univerjs/preset-sheets-core";
import UniverPresetSheetsCoreEnUS from "@univerjs/preset-sheets-core/locales/en-US";
import { UniverSheetsFilterPreset } from "@univerjs/preset-sheets-filter";
import UniverPresetSheetsFilterEnUS from "@univerjs/preset-sheets-filter/locales/en-US";
import { UniverSheetsFindReplacePreset } from "@univerjs/preset-sheets-find-replace";
import UniverPresetSheetsFindReplaceEnUS from "@univerjs/preset-sheets-find-replace/locales/en-US";
import { UniverSheetsSortPreset } from "@univerjs/preset-sheets-sort";
import UniverPresetSheetsSortEnUS from "@univerjs/preset-sheets-sort/locales/en-US";
import {
  createUniver,
  LocaleType,
  mergeLocales,
  type FUniver,
} from "@univerjs/presets";
import { generateWorkbookKeyBytes, importWorkbookKey } from "@zerosheet/crypto";
import {
  CellProtectionMap,
  decodeGoogleRange,
  encodeGoogleRange,
  SheetCoreError,
  type EditorCell,
  type GridRange,
} from "@zerosheet/sheet-core";
import {
  AlertTriangle,
  Columns3,
  Eraser,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Badge } from "./components/ui/badge.js";
import { Button } from "./components/ui/button.js";
import { Card, CardContent, CardHeader } from "./components/ui/card.js";

import "@univerjs/preset-sheets-core/lib/index.css";
import "@univerjs/preset-sheets-filter/lib/index.css";
import "@univerjs/preset-sheets-find-replace/lib/index.css";
import "@univerjs/preset-sheets-sort/lib/index.css";

const EDITOR_ROWS = 100;
const EDITOR_COLUMNS = 26;
const PREVIEW_RANGE: GridRange = {
  startRow: 0,
  endRow: EDITOR_ROWS - 1,
  startColumn: 0,
  endColumn: EDITOR_COLUMNS - 1,
};
const PREVIEW_WORKBOOK_ID = "zerosheet-m12-local-preview";
const PREVIEW_SHEET_ID = "zerosheet-m12-sheet-1";
const PREVIEW_SHEET_TITLE = "Customers";

type BatchState =
  | { readonly status: "starting" | "ready" | "preparing" }
  | {
      readonly status: "prepared";
      readonly encryptedCells: number;
      readonly unprotectedCells: number;
      readonly bytes: number;
    }
  | { readonly status: "error"; readonly message: string };

/**
 * Univer is only the local grid and formula engine. This component translates
 * its values into the storage-independent ZeroSheet core, which means Univer
 * never receives an OAuth token, Google response, recovery phrase, or raw key
 * bytes. The imported non-extractable CryptoKey remains in this component's
 * page lifetime and is intentionally unusable after a reload.
 */
export function EncryptedSheetEditor() {
  const containerRef = useRef<HTMLDivElement>(null);
  const univerRef = useRef<FUniver | null>(null);
  const workbookKeyRef = useRef<CryptoKey | null>(null);
  const protectionRef = useRef(new CellProtectionMap());
  const queuePreviewRef = useRef<(() => void) | null>(null);
  const [protectedCells, setProtectedCells] = useState(0);
  const [batch, setBatch] = useState<BatchState>({ status: "starting" });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let active = true;
    let previewTimer: number | undefined;
    const { univerAPI } = createUniver({
      locale: LocaleType.EN_US,
      locales: {
        [LocaleType.EN_US]: mergeLocales(
          UniverPresetSheetsCoreEnUS,
          UniverPresetSheetsSortEnUS,
          UniverPresetSheetsFilterEnUS,
          UniverPresetSheetsFindReplaceEnUS,
        ),
      },
      presets: [
        UniverSheetsCorePreset({ container }),
        UniverSheetsSortPreset(),
        UniverSheetsFilterPreset(),
        UniverSheetsFindReplacePreset(),
      ],
    });
    univerRef.current = univerAPI;
    univerAPI.createWorkbook({
      id: PREVIEW_WORKBOOK_ID,
      name: "ZeroSheet encrypted CRM preview",
      sheetOrder: [PREVIEW_SHEET_ID],
      sheets: {
        [PREVIEW_SHEET_ID]: {
          id: PREVIEW_SHEET_ID,
          name: PREVIEW_SHEET_TITLE,
          rowCount: EDITOR_ROWS,
          columnCount: EDITOR_COLUMNS,
          cellData: {
            0: {
              0: { v: "Customer" },
              1: { v: "Email" },
              2: { v: "Monthly value" },
              3: { v: "Annual value" },
              4: { v: "Status" },
            },
            1: {
              0: { v: "Acme Corp" },
              1: { v: "owner@acme.example" },
              2: { v: 4200 },
              3: { f: "=C2*12" },
              4: { v: "At Risk" },
            },
            2: {
              0: { v: "Northwind" },
              1: { v: "finance@northwind.example" },
              2: { v: 6800 },
              3: { f: "=C3*12" },
              4: { v: "Healthy" },
            },
          },
        },
      },
    });

    async function prepareEncryptedBatch(): Promise<void> {
      const key = workbookKeyRef.current;
      const workbook = univerAPI.getActiveWorkbook();
      if (!key || !workbook) return;
      setBatch({ status: "preparing" });

      try {
        const sheet = workbook.getActiveSheet();
        const data = sheet.getRange(
          PREVIEW_RANGE.startRow,
          PREVIEW_RANGE.startColumn,
          EDITOR_ROWS,
          EDITOR_COLUMNS,
        );
        const cells = editorCells(data.getValues(), data.getFormulas());
        const context = {
          workbookId: PREVIEW_WORKBOOK_ID,
          sheetId: PREVIEW_SHEET_ID,
          sheetTitle: PREVIEW_SHEET_TITLE,
          keyVersion: 1,
          key,
        } as const;
        const encoded = await encodeGoogleRange({
          context,
          range: PREVIEW_RANGE,
          cells,
          protection: protectionRef.current,
        });

        // A local decrypt immediately verifies every AAD coordinate and value
        // before this technical spike calls the batch ready. No ciphertext is
        // rendered, logged, persisted, or uploaded by the preview component.
        await decodeGoogleRange({
          context,
          range: PREVIEW_RANGE,
          values: encoded.valueRange.values,
        });
        const bytes = new TextEncoder().encode(
          JSON.stringify(encoded.valueRange),
        ).byteLength;
        if (active) {
          setBatch({
            status: "prepared",
            encryptedCells: encoded.encryptedCellCount,
            unprotectedCells: encoded.unprotectedCellCount,
            bytes,
          });
        }
      } catch (error) {
        if (active) {
          setBatch({
            status: "error",
            message:
              error instanceof SheetCoreError
                ? error.message
                : "The encrypted batch preview failed.",
          });
        }
      }
    }

    function queueEncryptedBatch(): void {
      if (previewTimer !== undefined) window.clearTimeout(previewTimer);
      previewTimer = window.setTimeout(() => {
        void prepareEncryptedBatch();
      }, 750);
    }
    queuePreviewRef.current = queueEncryptedBatch;

    const valueChanges = univerAPI.addEvent(
      univerAPI.Event.SheetValueChanged,
      () => queueEncryptedBatch(),
    );

    void (async () => {
      const rawKey = generateWorkbookKeyBytes();
      try {
        workbookKeyRef.current = await importWorkbookKey(rawKey);
        if (active) {
          setBatch({ status: "ready" });
          queueEncryptedBatch();
        }
      } catch {
        if (active) {
          setBatch({
            status: "error",
            message: "The browser could not initialize local encryption.",
          });
        }
      } finally {
        rawKey.fill(0);
      }
    })();

    return () => {
      active = false;
      if (previewTimer !== undefined) window.clearTimeout(previewTimer);
      queuePreviewRef.current = null;
      workbookKeyRef.current = null;
      univerRef.current = null;
      valueChanges.dispose();
      univerAPI.dispose();
    };
  }, []);

  function changeProtection(mode: "selection" | "columns" | "remove"): void {
    const activeSheet = univerRef.current
      ?.getActiveWorkbook()
      ?.getActiveSheet();
    const selected = activeSheet?.getActiveRange();
    if (!activeSheet || !selected) {
      setBatch({
        status: "error",
        message: "Select one or more cells in the grid first.",
      });
      return;
    }

    const selectedRange = selected.getRange();
    try {
      if (mode === "columns") {
        protectionRef.current.protectColumns({
          startColumn: selectedRange.startColumn,
          endColumn: selectedRange.endColumn,
          rowCount: activeSheet.getMaxRows(),
        });
      } else if (mode === "selection") {
        protectionRef.current.protectRange(selectedRange);
      } else {
        protectionRef.current.unprotectRange(selectedRange);
      }
      setProtectedCells(protectionRef.current.size);
      queuePreviewRef.current?.();
    } catch (error) {
      setBatch({
        status: "error",
        message:
          error instanceof SheetCoreError
            ? error.message
            : "The protection selection could not be changed.",
      });
    }
  }

  return (
    <Card className="mt-8" aria-labelledby="editor-heading">
      <CardHeader className="gap-6 border-b lg:flex-row lg:items-end lg:justify-between lg:space-y-0">
        <div className="max-w-3xl">
          <p className="mb-3 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Local encrypted sheet technical preview
          </p>
          <h2
            id="editor-heading"
            className="text-2xl font-medium tracking-tight sm:text-3xl"
          >
            Select exactly what Google cannot read.
          </h2>
          <p className="mt-3 text-sm font-light leading-6 text-muted-foreground">
            Editing, formulas, sorting, filtering, and search run in this
            browser. After a short pause, ZeroSheet prepares one
            Google-compatible batch and verifies every protected value locally.
          </p>
        </div>
        <Badge variant="accent" className="w-fit gap-2 px-3 py-2">
          <ShieldCheck className="h-4 w-4" />
          {protectedCells.toLocaleString()} protected cells
        </Badge>
      </CardHeader>

      <CardContent className="p-4 sm:p-6">
        <div
          className="mb-5 flex flex-wrap gap-2"
          aria-label="Cell protection controls"
        >
          <Button type="button" onClick={() => changeProtection("selection")}>
            <LockKeyhole />
            Protect selection
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => changeProtection("columns")}
          >
            <Columns3 />
            Protect selected columns
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => changeProtection("remove")}
          >
            <Eraser />
            Remove protection
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => queuePreviewRef.current?.()}
          >
            <RefreshCw />
            Prepare batch now
          </Button>
        </div>

        {/* Univer remains a light editing canvas in both shell themes because
            this release of its theme package provides no supported dark sheet
            palette. The surrounding shadcn shell still switches completely. */}
        <div className="univer-container" ref={containerRef} />

        <div
          className="mt-4 flex items-start gap-2 text-xs leading-5 text-muted-foreground"
          aria-live="polite"
        >
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {(batch.status === "starting" || batch.status === "ready") &&
              "Preparing the in-memory workbook key…"}
            {batch.status === "preparing" &&
              "Encrypting and verifying the current 100 × 26 batch…"}
            {batch.status === "prepared" && (
              <>
                Verified batch: {batch.encryptedCells.toLocaleString()}{" "}
                encrypted · {batch.unprotectedCells.toLocaleString()} visible to
                Google · {batch.bytes.toLocaleString()} bytes
              </>
            )}
            {batch.status === "error" && batch.message}
          </span>
        </div>

        <div className="mt-5 flex items-start gap-3 border-2 border-accent-border bg-accent px-4 py-3 text-xs leading-5 text-accent-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            This sample remains local because it is not tied to a product
            workbook. Real creation stores the creator’s HPKE envelope before
            the first Google write, so ZeroSheet never uploads ciphertext whose
            only workbook key disappears on reload.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function editorCells(
  values: readonly (readonly unknown[])[],
  formulas: readonly (readonly string[])[],
): EditorCell[][] {
  return values.map((row, rowIndex) =>
    row.map((value, columnIndex) => {
      const formula = formulas[rowIndex]?.[columnIndex];
      if (formula) return { value: null, formula };
      if (
        value === null ||
        typeof value === "string" ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value))
      ) {
        return { value };
      }
      throw new SheetCoreError("SHEET_INVALID_CELL");
    }),
  );
}
