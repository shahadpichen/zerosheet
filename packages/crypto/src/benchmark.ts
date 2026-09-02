import {
  decryptCell,
  encryptCell,
  serializedCellValueLength,
  type PlainCellValue,
} from "./cell.js";
import { generateWorkbookKeyBytes, importWorkbookKey } from "./workbook-key.js";

/**
 * A reproducible 100x100 smoke benchmark records payload expansion and local
 * Web Crypto time without outputting any plaintext, ciphertext, nonce, or key.
 * It is evidence for iteration, not a universal browser performance promise.
 */
async function runCellBenchmark(): Promise<void> {
  const dimension = 100;
  const totalCells = dimension * dimension;
  const workbookKeyBytes = generateWorkbookKeyBytes();
  const workbookKey = await importWorkbookKey(workbookKeyBytes);
  const encryptedCells: string[] = [];
  let plaintextBytes = 0;

  try {
    const encryptionStartedAt = performance.now();
    for (let row = 0; row < dimension; row += 1) {
      for (let column = 0; column < dimension; column += 1) {
        const value: PlainCellValue =
          column % 4 === 0
            ? { kind: "number", value: row * dimension + column }
            : column % 4 === 1
              ? { kind: "boolean", value: row % 2 === 0 }
              : column % 4 === 2
                ? { kind: "string", value: `record-${row}-${column}` }
                : { kind: "formula", value: `=A${row + 1}+1` };
        plaintextBytes += serializedCellValueLength(value);
        encryptedCells.push(
          await encryptCell(
            workbookKey,
            {
              workbookId: "benchmark-workbook",
              sheetId: "benchmark-sheet",
              row,
              column,
              keyVersion: 1,
            },
            value,
          ),
        );
      }
    }
    const encryptionDurationMs = performance.now() - encryptionStartedAt;

    let verifiedCells = 0;
    const decryptionStartedAt = performance.now();
    for (let row = 0; row < dimension; row += 1) {
      for (let column = 0; column < dimension; column += 1) {
        const encrypted = encryptedCells[row * dimension + column] as string;
        await decryptCell(
          workbookKey,
          {
            workbookId: "benchmark-workbook",
            sheetId: "benchmark-sheet",
            row,
            column,
            keyVersion: 1,
          },
          encrypted,
        );
        verifiedCells += 1;
      }
    }
    const decryptionDurationMs = performance.now() - decryptionStartedAt;
    const storedUtf8Bytes = encryptedCells.reduce(
      (total, cell) => total + new TextEncoder().encode(cell).byteLength,
      0,
    );

    if (
      verifiedCells !== totalCells ||
      new Set(encryptedCells).size !== totalCells
    ) {
      throw new Error("Cell benchmark verification failed.");
    }

    console.log(
      JSON.stringify({
        format: "zs1",
        dimensions: `${dimension}x${dimension}`,
        cells: totalCells,
        verifiedCells,
        uniqueCiphertexts: totalCells,
        serializedPlaintextBytes: plaintextBytes,
        storedUtf8Bytes,
        expansionRatio: Number((storedUtf8Bytes / plaintextBytes).toFixed(2)),
        encryptionDurationMs: Math.round(encryptionDurationMs),
        decryptionDurationMs: Math.round(decryptionDurationMs),
      }),
    );
  } finally {
    workbookKeyBytes.fill(0);
    encryptedCells.fill("");
  }
}

await runCellBenchmark();
