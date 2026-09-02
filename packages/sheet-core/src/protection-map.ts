import { SheetCoreError } from "./errors.js";
import {
  assertGridRange,
  coordinateKey,
  MAX_TRACKED_PROTECTED_CELLS,
  rangeCellCount,
  type GridCoordinate,
  type GridRange,
} from "./ranges.js";

/**
 * Protection is explicit per coordinate. A rectangle models drag selection;
 * a column operation expands over the current sheet row count. Encrypted blank
 * cells preserve the decision remotely because their `zs1` marker survives a
 * reload even though the logical value is empty.
 */
export class CellProtectionMap {
  readonly #protected = new Set<string>();

  /**
   * Autosave queues must capture the exact protection decision that existed
   * when Save was requested. Returning a new map prevents later drag/column
   * operations in the editor from changing an already queued storage write.
   */
  public clone(): CellProtectionMap {
    const copy = new CellProtectionMap();
    for (const coordinate of this.coordinates()) {
      copy.protectRange({
        startRow: coordinate.row,
        endRow: coordinate.row,
        startColumn: coordinate.column,
        endColumn: coordinate.column,
      });
    }
    return copy;
  }

  public get size(): number {
    return this.#protected.size;
  }

  public isProtected(row: number, column: number): boolean {
    return this.#protected.has(coordinateKey(row, column));
  }

  public protectRange(range: GridRange): void {
    this.apply(range, true);
  }

  public unprotectRange(range: GridRange): void {
    this.apply(range, false);
  }

  public protectColumns(input: {
    readonly startColumn: number;
    readonly endColumn: number;
    readonly rowCount: number;
  }): void {
    if (!Number.isSafeInteger(input.rowCount) || input.rowCount < 1) {
      throw new SheetCoreError("SHEET_INVALID_RANGE");
    }
    this.protectRange({
      startRow: 0,
      endRow: input.rowCount - 1,
      startColumn: input.startColumn,
      endColumn: input.endColumn,
    });
  }

  /** Sorted coordinates make diagnostics and tests deterministic. */
  public coordinates(): GridCoordinate[] {
    return [...this.#protected]
      .map((value) => {
        const [row, column] = value.split(":").map(Number);
        return { row: row as number, column: column as number };
      })
      .sort(
        (left, right) => left.row - right.row || left.column - right.column,
      );
  }

  private apply(range: GridRange, protect: boolean): void {
    assertGridRange(range);
    const operationCells = rangeCellCount(range);
    if (operationCells > MAX_TRACKED_PROTECTED_CELLS) {
      throw new SheetCoreError("SHEET_TOO_MANY_CELLS");
    }

    if (protect) {
      let newCells = 0;
      for (let row = range.startRow; row <= range.endRow; row += 1) {
        for (
          let column = range.startColumn;
          column <= range.endColumn;
          column += 1
        ) {
          if (!this.#protected.has(coordinateKey(row, column))) newCells += 1;
        }
      }
      if (this.#protected.size + newCells > MAX_TRACKED_PROTECTED_CELLS) {
        throw new SheetCoreError("SHEET_TOO_MANY_CELLS");
      }
    }

    for (let row = range.startRow; row <= range.endRow; row += 1) {
      for (
        let column = range.startColumn;
        column <= range.endColumn;
        column += 1
      ) {
        const key = coordinateKey(row, column);
        if (protect) this.#protected.add(key);
        else this.#protected.delete(key);
      }
    }
  }
}
