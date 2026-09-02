import { importWorkbookKey, isEncryptedCell } from "@zerosheet/crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  decodeGoogleRange,
  encodeGoogleRange,
  type EditorCell,
  type SheetCipherContext,
} from "./codec.js";
import { CellProtectionMap } from "./protection-map.js";
import type { GridRange } from "./ranges.js";

const range: GridRange = {
  startRow: 0,
  endRow: 1,
  startColumn: 0,
  endColumn: 2,
};
let context: SheetCipherContext;

beforeAll(async () => {
  const rawKey = new Uint8Array(32).fill(23);
  try {
    context = {
      workbookId: "3d9a575e-aed9-4634-b9ea-3f00334df680",
      sheetId: "google-tab-1938472",
      sheetTitle: "Owner's Budget",
      keyVersion: 1,
      key: await importWorkbookKey(rawKey),
    };
  } finally {
    rawKey.fill(0);
  }
});

describe("selective encrypted Sheet codec", () => {
  it("encrypts only selected cells and persists a protected blank marker", async () => {
    const protection = new CellProtectionMap();
    protection.protectRange({
      startRow: 0,
      endRow: 0,
      startColumn: 0,
      endColumn: 1,
    });
    const cells: EditorCell[][] = [
      [{ value: "Acme" }, { value: null }, { value: "Public ID" }],
      [{ value: 42 }, { value: null, formula: "=A2*2" }, { value: true }],
    ];

    const encoded = await encodeGoogleRange({
      context,
      range,
      cells,
      protection,
    });

    expect(encoded.valueRange.range).toBe("'Owner''s Budget'!A1:C2");
    expect(encoded.encryptedCellCount).toBe(2);
    expect(encoded.unprotectedCellCount).toBe(4);
    expect(isEncryptedCell(encoded.valueRange.values[0]?.[0])).toBe(true);
    expect(isEncryptedCell(encoded.valueRange.values[0]?.[1])).toBe(true);
    expect(encoded.valueRange.values[0]?.[2]).toBe("Public ID");
    expect(encoded.valueRange.values[1]?.[1]).toBe("=A2*2");

    const decoded = await decodeGoogleRange({
      context,
      range,
      values: encoded.valueRange.values,
    });
    expect(decoded.cells).toEqual(cells);
    expect(decoded.protection.coordinates()).toEqual([
      { row: 0, column: 0 },
      { row: 0, column: 1 },
    ]);
  });

  it("round-trips protected strings, numbers, booleans, formulas, and blanks", async () => {
    const protection = new CellProtectionMap();
    protection.protectRange(range);
    const cells: EditorCell[][] = [
      [{ value: "secret" }, { value: 42.75 }, { value: false }],
      [{ value: null }, { value: null, formula: "=B1*2" }, { value: true }],
    ];
    const encoded = await encodeGoogleRange({
      context,
      range,
      cells,
      protection,
    });

    const decoded = await decodeGoogleRange({
      context,
      range,
      values: encoded.valueRange.values,
    });

    expect(decoded.cells).toEqual(cells);
    expect(decoded.encryptedCellCount).toBe(6);
    expect(decoded.protection.size).toBe(6);
  });

  it("rejects copied ciphertext at its new coordinate", async () => {
    const protection = new CellProtectionMap();
    protection.protectRange({
      startRow: 0,
      endRow: 0,
      startColumn: 0,
      endColumn: 0,
    });
    const encoded = await encodeGoogleRange({
      context,
      range: {
        startRow: 0,
        endRow: 0,
        startColumn: 0,
        endColumn: 0,
      },
      cells: [[{ value: "secret" }]],
      protection,
    });

    await expect(
      decodeGoogleRange({
        context,
        range: {
          startRow: 1,
          endRow: 1,
          startColumn: 0,
          endColumn: 0,
        },
        values: encoded.valueRange.values,
      }),
    ).rejects.toMatchObject({
      code: "SHEET_CORRUPT_CIPHERTEXT",
      coordinate: "A2",
    });
  });

  it("fails before encryption when matrix dimensions or cell values are invalid", async () => {
    const protection = new CellProtectionMap();

    await expect(
      encodeGoogleRange({
        context,
        range,
        cells: [[{ value: "too short" }]],
        protection,
      }),
    ).rejects.toMatchObject({ code: "SHEET_INVALID_RANGE" });
    await expect(
      encodeGoogleRange({
        context,
        range: {
          startRow: 0,
          endRow: 0,
          startColumn: 0,
          endColumn: 0,
        },
        cells: [[{ value: Number.NaN }]],
        protection,
      }),
    ).rejects.toMatchObject({ code: "SHEET_INVALID_CELL" });
  });
});
