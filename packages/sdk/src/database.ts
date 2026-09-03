import {
  EncryptedCollection,
  normalizeCollectionDefinition,
} from "./collection.js";
import { EncryptedSheetDatabaseError } from "./errors.js";
import type {
  EncryptedSheetDatabaseOptions,
  EncryptedSheetRecord,
} from "./types.js";

/**
 * One database binds a recovered workbook key to one Google spreadsheet. Key
 * rotation creates a new instance with the new non-extractable key; mutating a
 * live instance's security context would let an in-flight save mix versions.
 */
export class EncryptedSheetDatabase {
  readonly #options: EncryptedSheetDatabaseOptions;
  readonly #collections = new Map<
    string,
    EncryptedCollection<EncryptedSheetRecord>
  >();

  public constructor(options: EncryptedSheetDatabaseOptions) {
    if (
      !isUuid(options.workbookId) ||
      !isGoogleResourceId(options.spreadsheetId) ||
      !Number.isSafeInteger(options.keyVersion) ||
      options.keyVersion < 1 ||
      options.key.type !== "secret" ||
      options.key.extractable ||
      options.key.algorithm.name !== "AES-GCM" ||
      !options.key.usages.includes("encrypt") ||
      !options.key.usages.includes("decrypt")
    ) {
      throw new EncryptedSheetDatabaseError("SDK_INVALID_CONFIG");
    }

    const entries = Object.entries(options.collections);
    if (entries.length < 1 || entries.length > 100) {
      throw new EncryptedSheetDatabaseError("SDK_INVALID_CONFIG");
    }

    // Validate every definition at construction so a typo fails before the
    // first network call. The normalized value is constructed again only when
    // its collection is requested; no secret data is retained during validation.
    for (const [name, definition] of entries) {
      normalizeCollectionDefinition(name, definition);
    }
    this.#options = options;
  }

  /**
   * Return one cached collection instance per name. Caching is important: its
   * internal queue serializes local mutations so two callers in the same tab do
   * not race each other before the Drive-version conflict check can run.
   */
  public collection<TRecord extends EncryptedSheetRecord>(
    name: string,
  ): EncryptedCollection<TRecord> {
    const existing = this.#collections.get(name);
    if (existing) return existing as EncryptedCollection<TRecord>;

    const source = this.#options.collections[name];
    if (!source) {
      throw new EncryptedSheetDatabaseError("SDK_INVALID_CONFIG");
    }
    const collection = new EncryptedCollection<EncryptedSheetRecord>({
      storage: this.#options.storage,
      spreadsheetId: this.#options.spreadsheetId,
      workbookId: this.#options.workbookId,
      keyVersion: this.#options.keyVersion,
      key: this.#options.key,
      definition: normalizeCollectionDefinition(name, source),
      idFactory: this.#options.idFactory ?? (() => crypto.randomUUID()),
    });
    this.#collections.set(name, collection);
    return collection as EncryptedCollection<TRecord>;
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

function isGoogleResourceId(value: string): boolean {
  return /^[A-Za-z0-9_-]{10,200}$/u.test(value);
}
