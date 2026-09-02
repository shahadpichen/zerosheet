import { generateWorkbookKeyBytes, importWorkbookKey } from "@zerosheet/crypto";
import {
  decodeGoogleRange,
  encodeGoogleRange,
  type EditorCell,
} from "./codec.js";
import { CellProtectionMap } from "./protection-map.js";

const rows = 100;
const columns = 100;
const range = {
  startRow: 0,
  endRow: rows - 1,
  startColumn: 0,
  endColumn: columns - 1,
} as const;

/**
 * Benchmark the product-plan 100x100 spike without printing any cell, key, or
 * ciphertext. Alternating columns are protected so the output also exercises
 * mixed protected/unprotected batch payloads.
 */
async function benchmark(): Promise<void> {
  const rawKey = generateWorkbookKeyBytes();
  const key = await importWorkbookKey(rawKey);
  rawKey.fill(0);
  const protection = new CellProtectionMap();
  for (let column = 0; column < columns; column += 2) {
    protection.protectColumns({
      startColumn: column,
      endColumn: column,
      rowCount: rows,
    });
  }
  const cells: EditorCell[][] = Array.from({ length: rows }, (_, row) =>
    Array.from({ length: columns }, (_, column) => ({
      value: `cell-${row}-${column}`,
    })),
  );
  const context = {
    workbookId: "benchmark-workbook",
    sheetId: "benchmark-tab",
    sheetTitle: "Benchmark",
    keyVersion: 1,
    key,
  } as const;

  const encryptStarted = performance.now();
  const encoded = await encodeGoogleRange({
    context,
    range,
    cells,
    protection,
  });
  const encryptMilliseconds = performance.now() - encryptStarted;

  const decryptStarted = performance.now();
  const decoded = await decodeGoogleRange({
    context,
    range,
    values: encoded.valueRange.values,
  });
  const decryptMilliseconds = performance.now() - decryptStarted;

  if (
    decoded.cells.length !== rows ||
    decoded.cells.some((row) => row.length !== columns) ||
    decoded.protection.size !== rows * (columns / 2)
  ) {
    throw new Error("The 100x100 benchmark did not verify its full result");
  }
  const payloadBytes = new TextEncoder().encode(
    JSON.stringify(encoded.valueRange),
  ).byteLength;
  console.log(
    JSON.stringify({
      cells: rows * columns,
      protectedCells: encoded.encryptedCellCount,
      unprotectedCells: encoded.unprotectedCellCount,
      encryptMilliseconds: Math.round(encryptMilliseconds),
      decryptMilliseconds: Math.round(decryptMilliseconds),
      googleBatchPayloadBytes: payloadBytes,
      verified: true,
    }),
  );
}

await benchmark();
