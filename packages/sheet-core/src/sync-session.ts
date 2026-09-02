import type {
  GoogleReadRange,
  GoogleSpreadsheetFile,
  GoogleValueRange,
} from "@zerosheet/google-storage";
import {
  decodeGoogleRange,
  encodeGoogleRange,
  type DecodedSheetRange,
  type EditorCell,
  type SheetCipherContext,
} from "./codec.js";
import { SheetCoreError } from "./errors.js";
import type { CellProtectionMap } from "./protection-map.js";
import { googleA1Range, type GridRange } from "./ranges.js";

/** Structural port keeps the synchronization core independent from fetch/UI. */
export interface SheetStoragePort {
  getSpreadsheet(spreadsheetId: string): Promise<GoogleSpreadsheetFile>;
  batchReadValues(
    spreadsheetId: string,
    ranges: readonly string[],
  ): Promise<GoogleReadRange[]>;
  batchWriteValues(
    spreadsheetId: string,
    ranges: readonly GoogleValueRange[],
  ): Promise<number>;
}

export interface SavedSheetRange {
  readonly updatedCells: number;
  readonly encryptedCells: number;
  readonly unprotectedCells: number;
  readonly driveVersion: string;
}

/**
 * One session binds an immutable ZeroSheet workbook, Google spreadsheet, tab,
 * and workbook-key version. Drive's file version is checked before writes so a
 * normal edit made elsewhere becomes a visible conflict instead of a silent
 * overwrite. Google offers no atomic compare-and-swap for a Sheets values
 * update, so a narrow check/write race remains documented.
 */
export class EncryptedSheetSyncSession {
  readonly #storage: SheetStoragePort;
  readonly #spreadsheetId: string;
  readonly #context: SheetCipherContext;
  #driveVersion: string | undefined;
  #saveTail: Promise<void> = Promise.resolve();

  public constructor(input: {
    readonly storage: SheetStoragePort;
    readonly spreadsheetId: string;
    readonly context: SheetCipherContext;
  }) {
    this.#storage = input.storage;
    this.#spreadsheetId = input.spreadsheetId;
    this.#context = input.context;
  }

  public async load(range: GridRange): Promise<DecodedSheetRange> {
    try {
      const before = await this.#storage.getSpreadsheet(this.#spreadsheetId);
      const remote = await this.#storage.batchReadValues(this.#spreadsheetId, [
        googleA1Range(this.#context.sheetTitle, range),
      ]);
      const after = await this.#storage.getSpreadsheet(this.#spreadsheetId);
      if (before.version !== after.version || remote.length !== 1) {
        throw new SheetCoreError("SHEET_CONFLICT");
      }
      const decoded = await decodeGoogleRange({
        context: this.#context,
        range,
        values: rectangularValues(remote[0] as GoogleReadRange, range),
      });
      this.#driveVersion = after.version;
      return decoded;
    } catch (error) {
      if (error instanceof SheetCoreError) throw error;
      throw new SheetCoreError("SHEET_STORAGE_UNAVAILABLE", { cause: error });
    }
  }

  public save(input: {
    readonly range: GridRange;
    readonly cells: readonly (readonly EditorCell[])[];
    readonly protection: CellProtectionMap;
  }): Promise<SavedSheetRange> {
    const snapshot = {
      range: { ...input.range },
      cells: input.cells.map((row) => row.map((cell) => ({ ...cell }))),
      protection: input.protection.clone(),
    };
    let resolveResult!: (value: SavedSheetRange) => void;
    let rejectResult!: (reason: unknown) => void;
    const result = new Promise<SavedSheetRange>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    // Serialize writes from autosave and explicit Save. Each call retains its
    // own immutable snapshot, while a failed save does not poison later queue
    // entries that may run after the user reloads.
    this.#saveTail = this.#saveTail
      .catch(() => undefined)
      .then(async () => {
        try {
          resolveResult(await this.saveNow(snapshot));
        } catch (error) {
          rejectResult(error);
        }
      });
    return result;
  }

  private async saveNow(input: {
    readonly range: GridRange;
    readonly cells: readonly (readonly EditorCell[])[];
    readonly protection: CellProtectionMap;
  }): Promise<SavedSheetRange> {
    if (!this.#driveVersion) throw new SheetCoreError("SHEET_NOT_LOADED");

    try {
      const current = await this.#storage.getSpreadsheet(this.#spreadsheetId);
      if (current.version !== this.#driveVersion) {
        throw new SheetCoreError("SHEET_CONFLICT");
      }
      const encoded = await encodeGoogleRange({
        context: this.#context,
        ...input,
      });
      const updatedCells = await this.#storage.batchWriteValues(
        this.#spreadsheetId,
        [encoded.valueRange],
      );
      const after = await this.#storage.getSpreadsheet(this.#spreadsheetId);
      this.#driveVersion = after.version;
      return {
        updatedCells,
        encryptedCells: encoded.encryptedCellCount,
        unprotectedCells: encoded.unprotectedCellCount,
        driveVersion: after.version,
      };
    } catch (error) {
      if (error instanceof SheetCoreError) throw error;
      throw new SheetCoreError("SHEET_STORAGE_UNAVAILABLE", { cause: error });
    }
  }
}

/** Google omits trailing blank rows/cells; pad them back to the requested rectangle. */
function rectangularValues(
  remote: GoogleReadRange,
  range: GridRange,
): GoogleReadRange["values"] {
  const rows = range.endRow - range.startRow + 1;
  const columns = range.endColumn - range.startColumn + 1;
  return Array.from({ length: rows }, (_, row) =>
    Array.from(
      { length: columns },
      (_unused, column) => remote.values[row]?.[column] ?? null,
    ),
  );
}
