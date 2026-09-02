import {
  decryptCell,
  encryptCell,
  inspectEncryptedCell,
  isEncryptedCell,
  type PlainCellValue,
} from "@zerosheet/crypto";
import type {
  GoogleCellScalar,
  GoogleValueRange,
} from "@zerosheet/google-storage";
import { SheetCoreError } from "./errors.js";
import { CellProtectionMap } from "./protection-map.js";
import {
  assertGridRange,
  coordinateLabel,
  googleA1Range,
  MAX_SYNC_CELLS,
  rangeCellCount,
  type GridRange,
} from "./ranges.js";

/** Formula is separate because spreadsheet engines expose calculated value and formula. */
export interface EditorCell {
  readonly value: GoogleCellScalar;
  readonly formula?: string;
}

export interface SheetCipherContext {
  readonly workbookId: string;
  readonly sheetId: string;
  readonly sheetTitle: string;
  readonly keyVersion: number;
  readonly key: CryptoKey;
}

export interface DecodedSheetRange {
  readonly cells: EditorCell[][];
  readonly protection: CellProtectionMap;
  readonly encryptedCellCount: number;
}

export interface EncodedSheetRange {
  readonly valueRange: GoogleValueRange;
  readonly encryptedCellCount: number;
  readonly unprotectedCellCount: number;
}

/**
 * Decrypt a complete range before returning it. One damaged marker rejects the
 * whole operation, so the UI never presents a silently partial plaintext view.
 */
export async function decodeGoogleRange(input: {
  readonly context: SheetCipherContext;
  readonly range: GridRange;
  readonly values: readonly (readonly GoogleCellScalar[])[];
}): Promise<DecodedSheetRange> {
  assertMatrixShape(input.range, input.values);
  const protection = new CellProtectionMap();
  let encryptedCellCount = 0;
  const cells: EditorCell[][] = [];

  for (let rowOffset = 0; rowOffset < input.values.length; rowOffset += 1) {
    const sourceRow = input.values[rowOffset] as readonly GoogleCellScalar[];
    const row = input.range.startRow + rowOffset;
    const openedRow = await Promise.all(
      sourceRow.map(async (value, columnOffset) => {
        const column = input.range.startColumn + columnOffset;
        if (!isEncryptedCell(value)) return remotePlainCell(value);

        const coordinate = coordinateLabel(row, column);
        try {
          const header = inspectEncryptedCell(value);
          if (header.keyVersion !== input.context.keyVersion) {
            throw new SheetCoreError("SHEET_CORRUPT_CIPHERTEXT", {
              coordinate,
            });
          }
          const plaintext = await decryptCell(
            input.context.key,
            {
              workbookId: input.context.workbookId,
              sheetId: input.context.sheetId,
              row,
              column,
              keyVersion: input.context.keyVersion,
            },
            value,
          );
          protection.protectRange({
            startRow: row,
            endRow: row,
            startColumn: column,
            endColumn: column,
          });
          encryptedCellCount += 1;
          return editorCell(plaintext);
        } catch (error) {
          if (error instanceof SheetCoreError) throw error;
          throw new SheetCoreError("SHEET_CORRUPT_CIPHERTEXT", {
            coordinate,
            cause: error,
          });
        }
      }),
    );
    cells.push(openedRow);
  }

  return { cells, protection, encryptedCellCount };
}

/**
 * Encode a dirty editor rectangle for one Google batch update. Protection is
 * looked up with global coordinates, so the same local value encrypted at a
 * different position receives different authenticated context and ciphertext.
 */
export async function encodeGoogleRange(input: {
  readonly context: SheetCipherContext;
  readonly range: GridRange;
  readonly cells: readonly (readonly EditorCell[])[];
  readonly protection: CellProtectionMap;
}): Promise<EncodedSheetRange> {
  assertMatrixShape(input.range, input.cells);
  let encryptedCellCount = 0;
  let unprotectedCellCount = 0;
  const values: GoogleCellScalar[][] = [];

  for (let rowOffset = 0; rowOffset < input.cells.length; rowOffset += 1) {
    const sourceRow = input.cells[rowOffset] as readonly EditorCell[];
    const row = input.range.startRow + rowOffset;
    const encodedRow = await Promise.all(
      sourceRow.map(async (cell, columnOffset) => {
        const column = input.range.startColumn + columnOffset;
        const plaintext = plainCell(cell);
        if (!input.protection.isProtected(row, column)) {
          unprotectedCellCount += 1;
          return googlePlainCell(plaintext);
        }

        encryptedCellCount += 1;
        return encryptCell(
          input.context.key,
          {
            workbookId: input.context.workbookId,
            sheetId: input.context.sheetId,
            row,
            column,
            keyVersion: input.context.keyVersion,
          },
          plaintext,
        );
      }),
    );
    values.push(encodedRow);
  }

  return {
    valueRange: {
      range: googleA1Range(input.context.sheetTitle, input.range),
      values,
    },
    encryptedCellCount,
    unprotectedCellCount,
  };
}

function plainCell(cell: EditorCell): PlainCellValue {
  if (cell.formula !== undefined) {
    if (!/^=.+/su.test(cell.formula)) {
      throw new SheetCoreError("SHEET_INVALID_CELL");
    }
    return { kind: "formula", value: cell.formula };
  }
  if (cell.value === null) return { kind: "blank" };
  if (typeof cell.value === "boolean") {
    return { kind: "boolean", value: cell.value };
  }
  if (typeof cell.value === "number") {
    if (!Number.isFinite(cell.value)) {
      throw new SheetCoreError("SHEET_INVALID_CELL");
    }
    return { kind: "number", value: cell.value };
  }
  if (typeof cell.value === "string") {
    return { kind: "string", value: cell.value };
  }
  throw new SheetCoreError("SHEET_INVALID_CELL");
}

function googlePlainCell(value: PlainCellValue): GoogleCellScalar {
  switch (value.kind) {
    case "blank":
      return null;
    case "formula":
      // RAW Google writes intentionally store this as literal text. Univer
      // evaluates it locally after reopening; Google never evaluates protected
      // formulas or attacker-controlled plaintext on ZeroSheet's behalf.
      return value.value;
    case "boolean":
    case "number":
    case "string":
      return value.value;
  }
}

function editorCell(value: PlainCellValue): EditorCell {
  switch (value.kind) {
    case "blank":
      return { value: null };
    case "formula":
      return { value: null, formula: value.value };
    case "boolean":
    case "number":
    case "string":
      return { value: value.value };
  }
}

function remotePlainCell(value: GoogleCellScalar): EditorCell {
  // FORMULA rendering returns formulas as leading-equals strings. RAW literal
  // strings with the same prefix are ambiguous in Google's values API; this
  // documented v1 tradeoff prefers restoring local formula behavior.
  return typeof value === "string" && /^=.+/su.test(value)
    ? { value: null, formula: value }
    : { value };
}

function assertMatrixShape(
  range: GridRange,
  values: readonly (readonly unknown[])[],
): void {
  assertGridRange(range);
  const expectedRows = range.endRow - range.startRow + 1;
  const expectedColumns = range.endColumn - range.startColumn + 1;
  if (
    rangeCellCount(range) > MAX_SYNC_CELLS ||
    values.length !== expectedRows ||
    values.some((row) => row.length !== expectedColumns)
  ) {
    throw new SheetCoreError(
      rangeCellCount(range) > MAX_SYNC_CELLS
        ? "SHEET_TOO_MANY_CELLS"
        : "SHEET_INVALID_RANGE",
    );
  }
}
