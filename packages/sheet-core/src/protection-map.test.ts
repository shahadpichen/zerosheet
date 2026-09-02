import { describe, expect, it } from "vitest";
import { CellProtectionMap } from "./protection-map.js";
import { googleA1Range } from "./ranges.js";

describe("CellProtectionMap", () => {
  it("supports a single cell, dragged rectangle, and full-column protection", () => {
    const map = new CellProtectionMap();
    map.protectRange({
      startRow: 2,
      endRow: 2,
      startColumn: 1,
      endColumn: 1,
    });
    map.protectRange({
      startRow: 4,
      endRow: 5,
      startColumn: 3,
      endColumn: 4,
    });
    map.protectColumns({ startColumn: 7, endColumn: 7, rowCount: 3 });

    expect(map.size).toBe(8);
    expect(map.isProtected(2, 1)).toBe(true);
    expect(map.isProtected(5, 4)).toBe(true);
    expect(map.isProtected(0, 7)).toBe(true);
    expect(map.isProtected(3, 7)).toBe(false);
  });

  it("removes only the selected coordinates", () => {
    const map = new CellProtectionMap();
    map.protectRange({
      startRow: 0,
      endRow: 2,
      startColumn: 0,
      endColumn: 2,
    });
    map.unprotectRange({
      startRow: 1,
      endRow: 1,
      startColumn: 1,
      endColumn: 2,
    });

    expect(map.size).toBe(7);
    expect(map.isProtected(1, 1)).toBe(false);
    expect(map.isProtected(1, 2)).toBe(false);
    expect(map.isProtected(0, 1)).toBe(true);
  });

  it("rejects invalid and unbounded selections before iterating them", () => {
    const map = new CellProtectionMap();

    expect(() =>
      map.protectRange({
        startRow: 2,
        endRow: 1,
        startColumn: 0,
        endColumn: 0,
      }),
    ).toThrowError(/invalid/u);
    expect(() =>
      map.protectColumns({
        startColumn: 0,
        endColumn: 100,
        rowCount: 10_000,
      }),
    ).toThrowError(/too many/u);
  });

  it("generates safely quoted A1 notation", () => {
    expect(
      googleA1Range("Owner's Budget", {
        startRow: 0,
        endRow: 9,
        startColumn: 0,
        endColumn: 27,
      }),
    ).toBe("'Owner''s Budget'!A1:AB10");
  });
});
