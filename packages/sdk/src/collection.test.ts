import type {
  GoogleCellScalar,
  GoogleReadRange,
  GoogleSpreadsheetFile,
  GoogleValueRange,
} from "@zerosheet/google-storage";
import { beforeEach, describe, expect, it } from "vitest";
import type { EncryptedCollection } from "./collection.js";
import { EncryptedSheetDatabase } from "./database.js";
import { EncryptedSheetDatabaseError } from "./errors.js";
import type { EncryptedSheetRecord } from "./types.js";

interface Customer extends EncryptedSheetRecord {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly status: string;
  readonly spend: number;
}

const WORKBOOK_ID = "00000000-0000-4000-8000-000000000141";
const SPREADSHEET_ID = "google_sheet_14";

let storage: MemorySheetStorage;
let collection: EncryptedCollection<Customer>;

beforeEach(async () => {
  storage = new MemorySheetStorage();
  collection = new EncryptedSheetDatabase({
    storage,
    spreadsheetId: SPREADSHEET_ID,
    workbookId: WORKBOOK_ID,
    keyVersion: 3,
    key: await generateWorkbookKey(),
    collections: {
      customers: {
        sheetId: "0",
        sheetTitle: "Customers",
        idPrefix: "cus_",
        maxRecords: 5,
        fields: [
          { name: "name" },
          { name: "email" },
          // Status is intentionally visible so a Google-side workflow can
          // route rows; the security tradeoff is explicit in configuration.
          { name: "status", protection: "public" },
          { name: "spend" },
        ],
      },
    },
    idFactory: () => "generated_1",
  }).collection<Customer>("customers");
});

describe("EncryptedCollection", () => {
  it("keeps stable IDs public and encrypts protected fields with the shared format", async () => {
    const inserted = await collection.insert(
      {
        name: "Acme Corp",
        email: "owner@acme.test",
        status: "active",
        spend: 4_200,
      },
      { id: "cus_123" },
    );

    expect(inserted.id).toBe("cus_123");
    expect(storage.cell(0, 0)).toBe("_id");
    expect(storage.cell(1, 0)).toBe("cus_123");
    expect(storage.cell(1, 1)).toMatch(/^zs1:/u);
    expect(storage.cell(1, 2)).toMatch(/^zs1:/u);
    expect(storage.cell(1, 3)).toBe("active");
    expect(storage.cell(1, 4)).toMatch(/^zs1:/u);
    await expect(collection.get("cus_123")).resolves.toEqual(inserted);
  });

  it("updates one row, clears deletion holes, and reuses the first free row", async () => {
    await collection.insert(customer("First", 100), { id: "cus_first" });
    await collection.insert(customer("Second", 200), { id: "cus_second" });
    const originalCiphertext = storage.cell(1, 4);

    await expect(
      collection.update("cus_first", { spend: 125, status: "review" }),
    ).resolves.toMatchObject({ spend: 125, status: "review" });
    expect(storage.cell(1, 4)).not.toBe(originalCiphertext);
    await expect(collection.delete("cus_first")).resolves.toBe(true);
    expect(storage.cell(1, 0)).toBeNull();

    await collection.insert(customer("Replacement", 300), {
      id: "cus_replacement",
    });
    expect(storage.cell(1, 0)).toBe("cus_replacement");
    await expect(collection.delete("does_not_exist")).resolves.toBe(false);
  });

  it("filters only after local decryption and paginates deterministic row order", async () => {
    await collection.insert(customer("One", 10), { id: "cus_1" });
    await collection.insert(customer("Two", 20), { id: "cus_2" });
    await collection.insert(customer("Three", 30), { id: "cus_3" });

    await expect(
      collection.filter((record) => record.spend >= 20, {
        offset: 1,
        limit: 1,
      }),
    ).resolves.toEqual({
      items: [expect.objectContaining({ id: "cus_3" })],
      offset: 1,
      limit: 1,
      total: 2,
      hasMore: false,
    });
    await expect(collection.page({ limit: 2 })).resolves.toMatchObject({
      items: [
        expect.objectContaining({ id: "cus_1" }),
        expect.objectContaining({ id: "cus_2" }),
      ],
      total: 3,
      hasMore: true,
    });
  });

  it("rejects duplicate IDs and records outside the fixed schema", async () => {
    await collection.insert(customer("One", 10), { id: "cus_1" });
    await expect(
      collection.insert(customer("Duplicate", 20), { id: "cus_1" }),
    ).rejects.toMatchObject({ code: "SDK_DUPLICATE_ID" });
    await expect(
      collection.insert(
        { ...customer("Extra", 30), unexpected: "field" },
        { id: "cus_extra" },
      ),
    ).rejects.toMatchObject({ code: "SDK_INVALID_RECORD" });
  });

  it("fails closed when a protected cell is replaced with plaintext", async () => {
    await collection.insert(customer("Protected", 10), { id: "cus_1" });
    storage.replaceCell(1, 1, "attacker plaintext");

    await expect(collection.get("cus_1")).rejects.toMatchObject({
      code: "SDK_CORRUPT_DATA",
    });
  });

  it("detects a Drive version change before a mutation", async () => {
    await collection.insert(customer("Before", 10), { id: "cus_1" });
    storage.bumpBeforeThirdNextGet();

    await expect(
      collection.update("cus_1", { spend: 11 }),
    ).rejects.toMatchObject({ code: "SDK_CONFLICT" });
    await expect(collection.get("cus_1")).resolves.toMatchObject({ spend: 10 });
  });

  it("rejects a mismatched existing header before decrypting records", async () => {
    storage.replaceCell(0, 0, "wrong_id");
    await expect(collection.all()).rejects.toEqual(
      new EncryptedSheetDatabaseError("SDK_SCHEMA_MISMATCH"),
    );
  });
});

function customer(name: string, spend: number): Omit<Customer, "id"> {
  return {
    name,
    email: `${name.toLowerCase()}@example.test`,
    status: "active",
    spend,
  };
}

async function generateWorkbookKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * A small in-memory Google adapter preserves the production port's exact
 * behavior relevant to the SDK: A1 ranges, omitted trailing blanks, monotonically
 * changing Drive versions, bounded writes, and row clears. Real HTTP validation
 * remains covered by @zerosheet/google-storage tests.
 */
class MemorySheetStorage {
  readonly #grid: GoogleCellScalar[][] = [];
  #version = 1;
  #getCalls = 0;
  #bumpOnGetCall: number | undefined;

  public getSpreadsheet(): Promise<GoogleSpreadsheetFile> {
    this.#getCalls += 1;
    if (this.#getCalls === this.#bumpOnGetCall) this.#version += 1;
    return Promise.resolve({
      id: SPREADSHEET_ID,
      name: "SDK test",
      version: String(this.#version),
      modifiedTime: "2026-09-03T00:00:00.000Z",
      webViewLink: "https://docs.google.com/spreadsheets/d/test",
    });
  }

  public batchReadValues(
    _spreadsheetId: string,
    ranges: readonly string[],
  ): Promise<GoogleReadRange[]> {
    return Promise.resolve(
      ranges.map((range) => {
        const parsed = parseA1Range(range);
        const values = Array.from(
          { length: parsed.endRow - parsed.startRow + 1 },
          (_, rowOffset) =>
            Array.from(
              { length: parsed.endColumn - parsed.startColumn + 1 },
              (_unused, columnOffset) =>
                this.#grid[parsed.startRow + rowOffset]?.[
                  parsed.startColumn + columnOffset
                ] ?? null,
            ),
        );
        return { range, values: trimGoogleBlanks(values) };
      }),
    );
  }

  public batchWriteValues(
    _spreadsheetId: string,
    ranges: readonly GoogleValueRange[],
  ): Promise<number> {
    let updated = 0;
    for (const valueRange of ranges) {
      const parsed = parseA1Range(valueRange.range);
      for (
        let rowOffset = 0;
        rowOffset < valueRange.values.length;
        rowOffset += 1
      ) {
        const values = valueRange.values[
          rowOffset
        ] as readonly GoogleCellScalar[];
        for (
          let columnOffset = 0;
          columnOffset < values.length;
          columnOffset += 1
        ) {
          this.setCell(
            parsed.startRow + rowOffset,
            parsed.startColumn + columnOffset,
            values[columnOffset] ?? null,
          );
          updated += 1;
        }
      }
    }
    this.#version += 1;
    return Promise.resolve(updated);
  }

  public batchClearValues(
    _spreadsheetId: string,
    ranges: readonly string[],
  ): Promise<void> {
    for (const range of ranges) {
      const parsed = parseA1Range(range);
      for (let row = parsed.startRow; row <= parsed.endRow; row += 1) {
        for (
          let column = parsed.startColumn;
          column <= parsed.endColumn;
          column += 1
        ) {
          this.setCell(row, column, null);
        }
      }
    }
    this.#version += 1;
    return Promise.resolve();
  }

  public cell(row: number, column: number): GoogleCellScalar {
    return this.#grid[row]?.[column] ?? null;
  }

  public replaceCell(
    row: number,
    column: number,
    value: GoogleCellScalar,
  ): void {
    this.setCell(row, column, value);
    this.#version += 1;
  }

  /** Simulate a different editor changing Drive after a two-read snapshot. */
  public bumpBeforeThirdNextGet(): void {
    this.#bumpOnGetCall = this.#getCalls + 3;
  }

  private setCell(row: number, column: number, value: GoogleCellScalar): void {
    const target = (this.#grid[row] ??= []);
    target[column] = value;
  }
}

interface ParsedRange {
  readonly startRow: number;
  readonly startColumn: number;
  readonly endRow: number;
  readonly endColumn: number;
}

function parseA1Range(value: string): ParsedRange {
  const match = /^'(?:[^']|'')+'!([A-Z]+)([0-9]+):([A-Z]+)([0-9]+)$/u.exec(
    value,
  );
  if (!match) throw new Error(`Invalid test A1 range: ${value}`);
  return {
    startColumn: columnIndex(match[1] as string),
    startRow: Number(match[2]) - 1,
    endColumn: columnIndex(match[3] as string),
    endRow: Number(match[4]) - 1,
  };
}

function columnIndex(label: string): number {
  let value = 0;
  for (const character of label) {
    value = value * 26 + character.charCodeAt(0) - 64;
  }
  return value - 1;
}

function trimGoogleBlanks(values: GoogleCellScalar[][]): GoogleCellScalar[][] {
  const trimmed = values.map((row) => {
    const copy = [...row];
    while (copy.at(-1) === null) copy.pop();
    return copy;
  });
  while (trimmed.at(-1)?.length === 0) trimmed.pop();
  return trimmed;
}
