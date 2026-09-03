import type {
  GoogleCellScalar,
  GoogleReadRange,
} from "@zerosheet/google-storage";
import {
  CellProtectionMap,
  decodeGoogleRange,
  encodeGoogleRange,
  googleA1Range,
  MAX_SYNC_CELLS,
  SheetCoreError,
  type EditorCell,
  type GridRange,
  type SheetCipherContext,
} from "@zerosheet/sheet-core";
import { EncryptedSheetDatabaseError } from "./errors.js";
import type {
  CollectionDefinition,
  CollectionFieldDefinition,
  CollectionPage,
  EncryptedSheetDatabaseStorage,
  EncryptedSheetRecord,
  InsertOptions,
  PaginationOptions,
} from "./types.js";

const HEADER_ID = "_id";
const DEFAULT_MAX_RECORDS = 1_000;
const MAX_RECORDS = 10_000;
const MAX_FIELDS = 99;
const MAX_BATCH_READ_RANGES = 100;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 1_000;

interface NormalizedFieldDefinition {
  readonly name: string;
  readonly protection: "protected" | "public";
  readonly column: number;
}

export interface NormalizedCollectionDefinition {
  readonly name: string;
  readonly sheetId: string;
  readonly sheetTitle: string;
  readonly fields: readonly NormalizedFieldDefinition[];
  readonly maxRecords: number;
  readonly idPrefix: string;
  readonly columnCount: number;
  readonly rowsPerChunk: number;
}

interface CollectionConstructorOptions {
  readonly storage: EncryptedSheetDatabaseStorage;
  readonly spreadsheetId: string;
  readonly workbookId: string;
  readonly keyVersion: number;
  readonly key: CryptoKey;
  readonly definition: NormalizedCollectionDefinition;
  readonly idFactory: () => string;
}

interface LocatedRecord<TRecord> {
  readonly row: number;
  readonly value: TRecord;
}

interface CollectionSnapshot<TRecord> {
  readonly driveVersion: string;
  readonly header: "absent" | "ready";
  readonly records: readonly LocatedRecord<TRecord>[];
  readonly emptyRows: readonly number[];
}

/**
 * One collection maps a fixed schema onto one existing Google tab. The public
 * `_id` column provides direct stable identity; every configured field defaults
 * to authenticated encryption with its exact row/column included in cell AAD.
 */
export class EncryptedCollection<TRecord extends EncryptedSheetRecord> {
  readonly #storage: EncryptedSheetDatabaseStorage;
  readonly #spreadsheetId: string;
  readonly #definition: NormalizedCollectionDefinition;
  readonly #context: SheetCipherContext;
  readonly #idFactory: () => string;
  #mutationTail: Promise<void> = Promise.resolve();

  public constructor(options: CollectionConstructorOptions) {
    this.#storage = options.storage;
    this.#spreadsheetId = options.spreadsheetId;
    this.#definition = options.definition;
    this.#context = {
      workbookId: options.workbookId,
      sheetId: options.definition.sheetId,
      sheetTitle: options.definition.sheetTitle,
      keyVersion: options.keyVersion,
      key: options.key,
    };
    this.#idFactory = options.idFactory;
  }

  /** Insert one record into the first free bounded row. */
  public insert(
    input: Omit<TRecord, "id">,
    options: InsertOptions = {},
  ): Promise<TRecord> {
    return this.enqueueMutation(async () => {
      let snapshot = await this.readSnapshot();
      if (snapshot.header === "absent") {
        await this.writeHeader(snapshot.driveVersion);
        snapshot = await this.readSnapshot();
      }

      const id = options.id ?? this.generatedId();
      assertRecordId(id);
      if (snapshot.records.some((record) => record.value.id === id)) {
        throw new EncryptedSheetDatabaseError("SDK_DUPLICATE_ID");
      }
      const row = snapshot.emptyRows[0];
      if (row === undefined) {
        throw new EncryptedSheetDatabaseError("SDK_CAPACITY_EXCEEDED");
      }
      const record = this.completeRecord(id, input);
      await this.writeRecord(row, record, snapshot.driveVersion);
      return cloneRecord(record);
    });
  }

  /** Return a record by its public stable ID, or null without leaking errors. */
  public async get(id: string): Promise<TRecord | null> {
    assertRecordId(id);
    await this.waitForMutations();
    const snapshot = await this.readSnapshot();
    const record = snapshot.records.find((entry) => entry.value.id === id);
    return record ? cloneRecord(record.value) : null;
  }

  /**
   * Replace only supplied fields. Record IDs and schema columns are immutable;
   * changing either would invalidate lookups or authenticated cell coordinates.
   */
  public update(
    id: string,
    patch: Partial<Omit<TRecord, "id">>,
  ): Promise<TRecord> {
    return this.enqueueMutation(async () => {
      assertRecordId(id);
      const snapshot = await this.readSnapshot();
      this.assertPatch(patch);
      const located = snapshot.records.find((entry) => entry.value.id === id);
      if (!located) throw new EncryptedSheetDatabaseError("SDK_NOT_FOUND");
      if (Object.keys(patch).length === 0) return cloneRecord(located.value);

      const updated = this.completeRecord(id, {
        ...located.value,
        ...patch,
        id: undefined,
      });
      await this.writeRecord(located.row, updated, snapshot.driveVersion);
      return cloneRecord(updated);
    });
  }

  /**
   * Clear the exact row instead of moving later rows. Moving ciphertext would
   * break row-bound AAD; stable holes are safely reused by a later insert.
   */
  public delete(id: string): Promise<boolean> {
    return this.enqueueMutation(async () => {
      assertRecordId(id);
      const snapshot = await this.readSnapshot();
      const located = snapshot.records.find((entry) => entry.value.id === id);
      if (!located) return false;

      await this.assertDriveVersion(snapshot.driveVersion);
      await this.#storage.batchClearValues(this.#spreadsheetId, [
        googleA1Range(this.#definition.sheetTitle, this.rowRange(located.row)),
      ]);
      await this.#storage.getSpreadsheet(this.#spreadsheetId);
      return true;
    });
  }

  /** Return every record in physical row order within the configured bound. */
  public async all(): Promise<readonly TRecord[]> {
    await this.waitForMutations();
    const snapshot = await this.readSnapshot();
    return snapshot.records.map((entry) => cloneRecord(entry.value));
  }

  /** Local filter: Google never receives the predicate or protected values. */
  public async filter(
    predicate: (record: Readonly<TRecord>) => boolean,
    options: PaginationOptions = {},
  ): Promise<CollectionPage<TRecord>> {
    const records = await this.all();
    return paginate(
      records.filter((record) => predicate(record)),
      options,
    );
  }

  /** Page physical row order after client-side decryption. */
  public async page(
    options: PaginationOptions = {},
  ): Promise<CollectionPage<TRecord>> {
    return paginate(await this.all(), options);
  }

  /** Explicit name makes plaintext export a visible security decision. */
  public exportPlaintext(): Promise<readonly TRecord[]> {
    return this.all();
  }

  private generatedId(): string {
    const value = `${this.#definition.idPrefix}${this.#idFactory()}`;
    assertRecordId(value);
    return value;
  }

  private completeRecord(
    id: string,
    input: Omit<TRecord, "id"> | Record<string, unknown>,
  ): TRecord {
    const source = input as Record<string, unknown>;
    const keys = Object.keys(source).filter(
      (key) => key !== "id" || source[key] !== undefined,
    );
    const expected = new Set(
      this.#definition.fields.map((field) => field.name),
    );
    if (
      keys.length !== expected.size ||
      keys.some((key) => !expected.has(key))
    ) {
      throw new EncryptedSheetDatabaseError("SDK_INVALID_RECORD");
    }

    const record: Record<string, GoogleCellScalar> = { id };
    for (const field of this.#definition.fields) {
      const value = source[field.name];
      if (!isCellScalar(value)) {
        throw new EncryptedSheetDatabaseError("SDK_INVALID_RECORD");
      }
      if (
        field.protection === "public" &&
        typeof value === "string" &&
        value.startsWith("=")
      ) {
        // Google FORMULA rendering cannot distinguish a RAW public string that
        // begins '=' from a formula. Protected strings are typed inside zs1 and
        // do not have this ambiguity.
        throw new EncryptedSheetDatabaseError("SDK_INVALID_RECORD");
      }
      record[field.name] = value;
    }
    return record as TRecord;
  }

  private assertPatch(patch: Partial<Omit<TRecord, "id">>): void {
    const allowed = new Set(this.#definition.fields.map((field) => field.name));
    for (const key of Object.keys(patch)) {
      if (key === "id" || !allowed.has(key)) {
        throw new EncryptedSheetDatabaseError("SDK_INVALID_RECORD");
      }
      const value = (patch as Record<string, unknown>)[key];
      const field = this.#definition.fields.find(
        (candidate) => candidate.name === key,
      );
      if (
        !isCellScalar(value) ||
        (field?.protection === "public" &&
          typeof value === "string" &&
          value.startsWith("="))
      ) {
        throw new EncryptedSheetDatabaseError("SDK_INVALID_RECORD");
      }
    }
  }

  private async readSnapshot(): Promise<CollectionSnapshot<TRecord>> {
    try {
      const before = await this.#storage.getSpreadsheet(this.#spreadsheetId);
      const ranges = [this.headerRange(), ...this.dataRanges()];
      const remote = await this.#storage.batchReadValues(
        this.#spreadsheetId,
        ranges.map((range) =>
          googleA1Range(this.#definition.sheetTitle, range),
        ),
      );
      const after = await this.#storage.getSpreadsheet(this.#spreadsheetId);
      if (before.version !== after.version) {
        throw new EncryptedSheetDatabaseError("SDK_CONFLICT");
      }
      if (remote.length !== ranges.length) {
        throw new EncryptedSheetDatabaseError("SDK_STORAGE_UNAVAILABLE");
      }

      const header = this.validateHeader(
        rectangularValues(remote[0] as GoogleReadRange, ranges[0] as GridRange),
      );
      const records: LocatedRecord<TRecord>[] = [];
      const emptyRows: number[] = [];
      const ids = new Set<string>();

      for (let index = 1; index < ranges.length; index += 1) {
        const range = ranges[index] as GridRange;
        const values = rectangularValues(
          remote[index] as GoogleReadRange,
          range,
        );
        const decoded = await decodeGoogleRange({
          context: this.#context,
          range,
          values,
        });

        for (let offset = 0; offset < values.length; offset += 1) {
          const row = range.startRow + offset;
          const rawRow = values[offset] as readonly GoogleCellScalar[];
          const decodedRow = decoded.cells[offset] as readonly EditorCell[];
          const idCell = decodedRow[0] as EditorCell;
          if (idCell.formula !== undefined) {
            throw new EncryptedSheetDatabaseError("SDK_CORRUPT_DATA");
          }

          if (idCell.value === null || idCell.value === "") {
            if (rawRow.some((value) => value !== null && value !== "")) {
              throw new EncryptedSheetDatabaseError("SDK_CORRUPT_DATA");
            }
            emptyRows.push(row);
            continue;
          }
          if (typeof idCell.value !== "string") {
            throw new EncryptedSheetDatabaseError("SDK_CORRUPT_DATA");
          }
          assertRecordId(idCell.value, "SDK_CORRUPT_DATA");
          if (ids.has(idCell.value)) {
            throw new EncryptedSheetDatabaseError("SDK_CORRUPT_DATA");
          }
          ids.add(idCell.value);

          const record: Record<string, GoogleCellScalar> = { id: idCell.value };
          for (const field of this.#definition.fields) {
            const cell = decodedRow[field.column] as EditorCell;
            const encrypted = decoded.protection.isProtected(row, field.column);
            if (
              cell.formula !== undefined ||
              (field.protection === "protected") !== encrypted
            ) {
              // A plaintext value in a protected column is a downgrade, not a
              // legitimate edit. An encrypted public field means the caller is
              // using a different schema against the same tab.
              throw new EncryptedSheetDatabaseError("SDK_CORRUPT_DATA");
            }
            record[field.name] = cell.value;
          }
          records.push({ row, value: record as TRecord });
        }
      }

      if (header === "absent" && records.length > 0) {
        throw new EncryptedSheetDatabaseError("SDK_SCHEMA_MISMATCH");
      }
      return { driveVersion: after.version, header, records, emptyRows };
    } catch (error) {
      throw translateError(error);
    }
  }

  private validateHeader(
    values: readonly (readonly GoogleCellScalar[])[],
  ): "absent" | "ready" {
    const row = values[0] as readonly GoogleCellScalar[];
    if (row.every((value) => value === null || value === "")) return "absent";
    const expected = [
      HEADER_ID,
      ...this.#definition.fields.map((field) => field.name),
    ];
    if (row.some((value, index) => value !== expected[index])) {
      throw new EncryptedSheetDatabaseError("SDK_SCHEMA_MISMATCH");
    }
    return "ready";
  }

  private async writeHeader(driveVersion: string): Promise<void> {
    try {
      await this.assertDriveVersion(driveVersion);
      const updated = await this.#storage.batchWriteValues(
        this.#spreadsheetId,
        [
          {
            range: googleA1Range(
              this.#definition.sheetTitle,
              this.headerRange(),
            ),
            values: [
              [
                HEADER_ID,
                ...this.#definition.fields.map((field) => field.name),
              ],
            ],
          },
        ],
      );
      if (updated !== this.#definition.columnCount) {
        throw new EncryptedSheetDatabaseError("SDK_STORAGE_UNAVAILABLE");
      }
    } catch (error) {
      throw translateError(error);
    }
  }

  private async writeRecord(
    row: number,
    record: TRecord,
    driveVersion: string,
  ): Promise<void> {
    try {
      await this.assertDriveVersion(driveVersion);
      const range = this.rowRange(row);
      const protection = new CellProtectionMap();
      for (const field of this.#definition.fields) {
        if (field.protection === "protected") {
          protection.protectRange({
            startRow: row,
            endRow: row,
            startColumn: field.column,
            endColumn: field.column,
          });
        }
      }
      const encoded = await encodeGoogleRange({
        context: this.#context,
        range,
        cells: [
          [
            { value: record.id },
            ...this.#definition.fields.map((field) => ({
              value: record[field.name] ?? null,
            })),
          ],
        ],
        protection,
      });
      const updated = await this.#storage.batchWriteValues(
        this.#spreadsheetId,
        [encoded.valueRange],
      );
      if (updated !== this.#definition.columnCount) {
        throw new EncryptedSheetDatabaseError("SDK_STORAGE_UNAVAILABLE");
      }
      await this.#storage.getSpreadsheet(this.#spreadsheetId);
    } catch (error) {
      throw translateError(error);
    }
  }

  private async assertDriveVersion(expected: string): Promise<void> {
    const current = await this.#storage.getSpreadsheet(this.#spreadsheetId);
    if (current.version !== expected) {
      throw new EncryptedSheetDatabaseError("SDK_CONFLICT");
    }
  }

  private headerRange(): GridRange {
    return {
      startRow: 0,
      endRow: 0,
      startColumn: 0,
      endColumn: this.#definition.columnCount - 1,
    };
  }

  private rowRange(row: number): GridRange {
    return {
      startRow: row,
      endRow: row,
      startColumn: 0,
      endColumn: this.#definition.columnCount - 1,
    };
  }

  private dataRanges(): readonly GridRange[] {
    const ranges: GridRange[] = [];
    for (
      let startRow = 1;
      startRow <= this.#definition.maxRecords;
      startRow += this.#definition.rowsPerChunk
    ) {
      ranges.push({
        startRow,
        endRow: Math.min(
          this.#definition.maxRecords,
          startRow + this.#definition.rowsPerChunk - 1,
        ),
        startColumn: 0,
        endColumn: this.#definition.columnCount - 1,
      });
    }
    return ranges;
  }

  private enqueueMutation<TResult>(
    operation: () => Promise<TResult>,
  ): Promise<TResult> {
    let resolveResult!: (value: TResult) => void;
    let rejectResult!: (reason: unknown) => void;
    const result = new Promise<TResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.#mutationTail = this.#mutationTail
      .catch(() => undefined)
      .then(async () => {
        try {
          resolveResult(await operation());
        } catch (error) {
          rejectResult(translateError(error));
        }
      });
    return result;
  }

  private async waitForMutations(): Promise<void> {
    await this.#mutationTail.catch(() => undefined);
  }
}

/** Validate and freeze the data-layout decisions before any storage access. */
export function normalizeCollectionDefinition(
  name: string,
  definition: CollectionDefinition,
): NormalizedCollectionDefinition {
  if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(name)) {
    throw new EncryptedSheetDatabaseError("SDK_INVALID_CONFIG");
  }
  if (
    !/^(?:0|[1-9][0-9]{0,9})$/u.test(definition.sheetId) ||
    Number(definition.sheetId) > 2_147_483_647 ||
    !isSafeName(definition.sheetTitle) ||
    definition.fields.length < 1 ||
    definition.fields.length > MAX_FIELDS
  ) {
    throw new EncryptedSheetDatabaseError("SDK_INVALID_CONFIG");
  }

  const names = new Set<string>();
  const fields = definition.fields.map((field, index) => {
    assertField(field, names);
    names.add(field.name);
    return {
      name: field.name,
      protection: field.protection ?? "protected",
      column: index + 1,
    } as const;
  });
  const maxRecords = definition.maxRecords ?? DEFAULT_MAX_RECORDS;
  const idPrefix = definition.idPrefix ?? "rec_";
  const columnCount = fields.length + 1;
  const rowsPerChunk = Math.floor(MAX_SYNC_CELLS / columnCount);
  const readRanges = 1 + Math.ceil(maxRecords / rowsPerChunk);
  if (
    !Number.isSafeInteger(maxRecords) ||
    maxRecords < 1 ||
    maxRecords > MAX_RECORDS ||
    !/^[A-Za-z][A-Za-z0-9_-]{0,15}$/u.test(idPrefix) ||
    readRanges > MAX_BATCH_READ_RANGES
  ) {
    throw new EncryptedSheetDatabaseError("SDK_INVALID_CONFIG");
  }

  return {
    name,
    sheetId: definition.sheetId,
    sheetTitle: definition.sheetTitle,
    fields,
    maxRecords,
    idPrefix,
    columnCount,
    rowsPerChunk,
  };
}

function assertField(
  field: CollectionFieldDefinition,
  existing: ReadonlySet<string>,
): void {
  if (
    !isSafeName(field.name) ||
    field.name === "id" ||
    field.name === HEADER_ID ||
    field.name === "__proto__" ||
    field.name === "prototype" ||
    field.name === "constructor" ||
    existing.has(field.name) ||
    (field.protection !== undefined &&
      field.protection !== "protected" &&
      field.protection !== "public")
  ) {
    throw new EncryptedSheetDatabaseError("SDK_INVALID_CONFIG");
  }
}

function isSafeName(value: string): boolean {
  if (value.length < 1 || value.length > 100) return false;
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code <= 0x1f || code === 0x7f)) return false;
  }
  return true;
}

function isCellScalar(value: unknown): value is GoogleCellScalar {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function assertRecordId(
  value: string,
  errorCode: "SDK_INVALID_RECORD" | "SDK_CORRUPT_DATA" = "SDK_INVALID_RECORD",
): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value)) {
    throw new EncryptedSheetDatabaseError(errorCode);
  }
}

function rectangularValues(
  remote: GoogleReadRange,
  range: GridRange,
): GoogleCellScalar[][] {
  const rows = range.endRow - range.startRow + 1;
  const columns = range.endColumn - range.startColumn + 1;
  return Array.from({ length: rows }, (_, row) =>
    Array.from(
      { length: columns },
      (_unused, column) => remote.values[row]?.[column] ?? null,
    ),
  );
}

function paginate<TRecord>(
  records: readonly TRecord[],
  options: PaginationOptions,
): CollectionPage<TRecord> {
  const offset = options.offset ?? 0;
  const limit = options.limit ?? DEFAULT_PAGE_SIZE;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_PAGE_SIZE
  ) {
    throw new EncryptedSheetDatabaseError("SDK_INVALID_CONFIG");
  }
  return {
    items: records.slice(offset, offset + limit),
    offset,
    limit,
    total: records.length,
    hasMore: offset + limit < records.length,
  };
}

function cloneRecord<TRecord extends EncryptedSheetRecord>(
  record: TRecord,
): TRecord {
  return { ...record };
}

function translateError(error: unknown): EncryptedSheetDatabaseError {
  if (error instanceof EncryptedSheetDatabaseError) return error;
  if (error instanceof SheetCoreError) {
    return new EncryptedSheetDatabaseError(
      error.code === "SHEET_CONFLICT"
        ? "SDK_CONFLICT"
        : error.code === "SHEET_CORRUPT_CIPHERTEXT"
          ? "SDK_CORRUPT_DATA"
          : "SDK_STORAGE_UNAVAILABLE",
      { cause: error },
    );
  }
  return new EncryptedSheetDatabaseError("SDK_STORAGE_UNAVAILABLE", {
    cause: error,
  });
}
