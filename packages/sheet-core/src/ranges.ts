import { SheetCoreError } from "./errors.js";

export const MAX_SYNC_CELLS = 10_000;
export const MAX_TRACKED_PROTECTED_CELLS = 100_000;

/** Inclusive, zero-based coordinates match the crypto AAD and Univer ranges. */
export interface GridRange {
  readonly startRow: number;
  readonly startColumn: number;
  readonly endRow: number;
  readonly endColumn: number;
}

export interface GridCoordinate {
  readonly row: number;
  readonly column: number;
}

export function assertGridRange(range: GridRange): void {
  const values = [
    range.startRow,
    range.startColumn,
    range.endRow,
    range.endColumn,
  ];
  if (
    values.some(
      (value) =>
        !Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff,
    ) ||
    range.endRow < range.startRow ||
    range.endColumn < range.startColumn
  ) {
    throw new SheetCoreError("SHEET_INVALID_RANGE");
  }
}

export function rangeCellCount(range: GridRange): number {
  assertGridRange(range);
  const rows = range.endRow - range.startRow + 1;
  const columns = range.endColumn - range.startColumn + 1;
  const count = rows * columns;
  if (!Number.isSafeInteger(count)) {
    throw new SheetCoreError("SHEET_TOO_MANY_CELLS");
  }
  return count;
}

export function coordinateKey(row: number, column: number): string {
  assertCoordinate(row, column);
  return `${row}:${column}`;
}

export function coordinateLabel(row: number, column: number): string {
  assertCoordinate(row, column);
  return `${columnLabel(column)}${row + 1}`;
}

/**
 * Google accepts quoted sheet titles in A1 notation. Always quoting and
 * doubling apostrophes avoids ambiguous titles such as `Sales 2026` or `A1`.
 */
export function googleA1Range(sheetTitle: string, range: GridRange): string {
  assertGridRange(range);
  if (
    sheetTitle.length < 1 ||
    sheetTitle.length > 100 ||
    containsControlCharacter(sheetTitle)
  ) {
    throw new SheetCoreError("SHEET_INVALID_RANGE");
  }
  const escapedTitle = sheetTitle.replaceAll("'", "''");
  return `'${escapedTitle}'!${coordinateLabel(
    range.startRow,
    range.startColumn,
  )}:${coordinateLabel(range.endRow, range.endColumn)}`;
}

function columnLabel(column: number): string {
  let remaining = column + 1;
  let label = "";
  while (remaining > 0) {
    const index = (remaining - 1) % 26;
    label = String.fromCharCode(65 + index) + label;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return label;
}

function assertCoordinate(row: number, column: number): void {
  if (
    !Number.isSafeInteger(row) ||
    row < 0 ||
    row > 0xffff_ffff ||
    !Number.isSafeInteger(column) ||
    column < 0 ||
    column > 0xffff_ffff
  ) {
    throw new SheetCoreError("SHEET_INVALID_RANGE");
  }
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code <= 0x1f || code === 0x7f)) return true;
  }
  return false;
}
