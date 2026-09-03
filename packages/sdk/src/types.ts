import type {
  GoogleCellScalar,
  GoogleReadRange,
  GoogleSpreadsheetFile,
  GoogleValueRange,
} from "@zerosheet/google-storage";

export type EncryptedSheetScalar = GoogleCellScalar;

/**
 * `id` is public by design so the SDK can locate a row without a searchable
 * encryption index. Every other configured field is protected unless its
 * definition explicitly opts into public Google-visible storage.
 */
export interface EncryptedSheetRecord {
  readonly id: string;
  readonly [field: string]: EncryptedSheetScalar;
}

export interface CollectionFieldDefinition {
  readonly name: string;
  readonly protection?: "protected" | "public";
}

export interface CollectionDefinition {
  /** Stable numeric Google tab ID represented as a string for cell AAD. */
  readonly sheetId: string;
  /** Current Google tab title used only to build safely quoted A1 ranges. */
  readonly sheetTitle: string;
  /** Fixed column order. Renaming/reordering is a versioned data migration. */
  readonly fields: readonly CollectionFieldDefinition[];
  /** Bounded scan/capacity; defaults to 1,000 records. */
  readonly maxRecords?: number;
  /** Prefix for generated public IDs; defaults to `rec_`. */
  readonly idPrefix?: string;
}

/**
 * Structural port makes the SDK testable and usable with the reviewed
 * GoogleWorkspaceStorage adapter without importing fetch or OAuth concerns.
 */
export interface EncryptedSheetDatabaseStorage {
  getSpreadsheet(spreadsheetId: string): Promise<GoogleSpreadsheetFile>;
  batchReadValues(
    spreadsheetId: string,
    ranges: readonly string[],
  ): Promise<GoogleReadRange[]>;
  batchWriteValues(
    spreadsheetId: string,
    ranges: readonly GoogleValueRange[],
  ): Promise<number>;
  batchClearValues(
    spreadsheetId: string,
    ranges: readonly string[],
  ): Promise<void>;
}

export interface EncryptedSheetDatabaseOptions {
  readonly storage: EncryptedSheetDatabaseStorage;
  readonly spreadsheetId: string;
  readonly workbookId: string;
  readonly keyVersion: number;
  readonly key: CryptoKey;
  readonly collections: Readonly<Record<string, CollectionDefinition>>;

  /** Test/deterministic import seam; normal applications use crypto.randomUUID. */
  readonly idFactory?: () => string;
}

export interface CollectionPage<TRecord> {
  readonly items: readonly TRecord[];
  readonly offset: number;
  readonly limit: number;
  readonly total: number;
  readonly hasMore: boolean;
}

export interface PaginationOptions {
  readonly offset?: number;
  readonly limit?: number;
}

export interface InsertOptions {
  /** Optional application ID such as `cus_123`; otherwise one is generated. */
  readonly id?: string;
}
