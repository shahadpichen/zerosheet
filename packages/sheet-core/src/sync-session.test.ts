import { importWorkbookKey } from "@zerosheet/crypto";
import type {
  GoogleReadRange,
  GoogleSpreadsheetFile,
  GoogleValueRange,
} from "@zerosheet/google-storage";
import { beforeAll, describe, expect, it } from "vitest";
import { decodeGoogleRange, type SheetCipherContext } from "./codec.js";
import { CellProtectionMap } from "./protection-map.js";
import {
  EncryptedSheetSyncSession,
  type SheetStoragePort,
} from "./sync-session.js";

class FakeSheetStorage implements SheetStoragePort {
  public version = "1";
  public versionAfterRead: string | undefined;
  public readonly writes: GoogleValueRange[][] = [];
  public values: GoogleReadRange[] = [
    { range: "'Sheet1'!A1:B2", values: [["Acme", 7]] },
  ];
  public activeWrites = 0;
  public maximumConcurrentWrites = 0;

  public getSpreadsheet(spreadsheetId: string): Promise<GoogleSpreadsheetFile> {
    const currentVersion = this.version;
    if (this.versionAfterRead && this.writes.length === 0) {
      this.version = this.versionAfterRead;
      this.versionAfterRead = undefined;
    }
    return Promise.resolve({
      id: spreadsheetId,
      name: "Encrypted budget",
      version: currentVersion,
      modifiedTime: "2026-09-03T01:00:00.000Z",
      webViewLink: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
    });
  }

  public batchReadValues(): Promise<GoogleReadRange[]> {
    return Promise.resolve(this.values);
  }

  public async batchWriteValues(
    _spreadsheetId: string,
    ranges: readonly GoogleValueRange[],
  ): Promise<number> {
    this.activeWrites += 1;
    this.maximumConcurrentWrites = Math.max(
      this.maximumConcurrentWrites,
      this.activeWrites,
    );
    await Promise.resolve();
    this.writes.push([...ranges]);
    this.version = String(Number(this.version) + 1);
    this.activeWrites -= 1;
    return ranges.reduce(
      (total, range) =>
        total + range.values.reduce((sum, row) => sum + row.length, 0),
      0,
    );
  }
}

let context: SheetCipherContext;

beforeAll(async () => {
  const rawKey = new Uint8Array(32).fill(29);
  try {
    context = {
      workbookId: "3d9a575e-aed9-4634-b9ea-3f00334df680",
      sheetId: "google-tab-0",
      sheetTitle: "Sheet1",
      keyVersion: 1,
      key: await importWorkbookKey(rawKey),
    };
  } finally {
    rawKey.fill(0);
  }
});

function createSession(storage: FakeSheetStorage): EncryptedSheetSyncSession {
  return new EncryptedSheetSyncSession({
    storage,
    spreadsheetId: "1Spreadsheet_Resource_Id_123",
    context,
  });
}

const range = {
  startRow: 0,
  endRow: 1,
  startColumn: 0,
  endColumn: 1,
} as const;

describe("EncryptedSheetSyncSession", () => {
  it("loads one stable Drive version and pads Google's omitted trailing blanks", async () => {
    const storage = new FakeSheetStorage();

    await expect(createSession(storage).load(range)).resolves.toMatchObject({
      cells: [
        [{ value: "Acme" }, { value: 7 }],
        [{ value: null }, { value: null }],
      ],
    });
  });

  it("rejects a read when Drive changes during the read window", async () => {
    const storage = new FakeSheetStorage();
    storage.versionAfterRead = "2";

    await expect(createSession(storage).load(range)).rejects.toMatchObject({
      code: "SHEET_CONFLICT",
    });
  });

  it("detects an external edit before writing", async () => {
    const storage = new FakeSheetStorage();
    const session = createSession(storage);
    const loaded = await session.load(range);
    storage.version = "8";

    await expect(
      session.save({
        range,
        cells: loaded.cells,
        protection: loaded.protection,
      }),
    ).rejects.toMatchObject({ code: "SHEET_CONFLICT" });
    expect(storage.writes).toHaveLength(0);
  });

  it("serializes simultaneous saves and advances the observed Drive version", async () => {
    const storage = new FakeSheetStorage();
    const session = createSession(storage);
    const loaded = await session.load(range);
    const protection = new CellProtectionMap();
    protection.protectRange({
      startRow: 0,
      endRow: 0,
      startColumn: 0,
      endColumn: 0,
    });

    const first = session.save({
      range,
      cells: loaded.cells,
      protection,
    });
    const second = session.save({
      range,
      cells: [
        [{ value: "Updated" }, { value: 7 }],
        [{ value: null }, { value: null }],
      ],
      protection,
    });

    await expect(first).resolves.toMatchObject({ driveVersion: "2" });
    await expect(second).resolves.toMatchObject({ driveVersion: "3" });
    expect(storage.maximumConcurrentWrites).toBe(1);
    expect(storage.writes).toHaveLength(2);
  });

  it("captures cells and protection before placing an autosave in the queue", async () => {
    const storage = new FakeSheetStorage();
    const session = createSession(storage);
    await session.load(range);
    const cells = [
      [{ value: "Original" }, { value: 7 }],
      [{ value: null }, { value: null }],
    ];
    const protection = new CellProtectionMap();
    protection.protectRange({
      startRow: 0,
      endRow: 0,
      startColumn: 0,
      endColumn: 0,
    });

    const save = session.save({ range, cells, protection });

    // These edits happen before the queued promise starts. They model a fast
    // user continuing to type or changing protection during an earlier save.
    // The in-flight write must retain "Original" and its protected state.
    cells[0]![0] = { value: "Mutated after Save" };
    protection.unprotectRange({
      startRow: 0,
      endRow: 0,
      startColumn: 0,
      endColumn: 0,
    });

    await expect(save).resolves.toMatchObject({ encryptedCells: 1 });
    const written = storage.writes[0]![0]!;
    const decoded = await decodeGoogleRange({
      context,
      range,
      values: written.values,
    });
    expect(decoded.cells[0]![0]).toEqual({ value: "Original" });
    expect(decoded.protection.isProtected(0, 0)).toBe(true);
  });

  it("requires a successful load before the first save", async () => {
    const storage = new FakeSheetStorage();
    const session = createSession(storage);

    await expect(
      session.save({
        range,
        cells: [
          [{ value: "A" }, { value: "B" }],
          [{ value: "C" }, { value: "D" }],
        ],
        protection: new CellProtectionMap(),
      }),
    ).rejects.toMatchObject({ code: "SHEET_NOT_LOADED" });
  });
});
