export type EncryptedSheetDatabaseErrorCode =
  | "SDK_INVALID_CONFIG"
  | "SDK_INVALID_RECORD"
  | "SDK_DUPLICATE_ID"
  | "SDK_NOT_FOUND"
  | "SDK_CAPACITY_EXCEEDED"
  | "SDK_SCHEMA_MISMATCH"
  | "SDK_CORRUPT_DATA"
  | "SDK_CONFLICT"
  | "SDK_STORAGE_UNAVAILABLE";

const SAFE_MESSAGES: Readonly<Record<EncryptedSheetDatabaseErrorCode, string>> =
  {
    SDK_INVALID_CONFIG: "The encrypted collection configuration is invalid.",
    SDK_INVALID_RECORD: "The record does not match the collection schema.",
    SDK_DUPLICATE_ID: "A record with that public ID already exists.",
    SDK_NOT_FOUND: "The requested record does not exist.",
    SDK_CAPACITY_EXCEEDED: "The configured collection capacity is full.",
    SDK_SCHEMA_MISMATCH:
      "The Google Sheet header does not match the collection schema.",
    SDK_CORRUPT_DATA:
      "The collection contains invalid or unauthenticated encrypted data.",
    SDK_CONFLICT:
      "The Google Sheet changed during this operation. Reload and retry.",
    SDK_STORAGE_UNAVAILABLE: "The Google Sheet storage operation failed.",
  };

/**
 * Stable codes let applications choose safe recovery UX without inspecting a
 * Google, Web Crypto, or parser error. Provider details stay in `cause` for a
 * local debugger; applications must never serialize that object into telemetry
 * because it can contain resource metadata or encrypted cell material.
 */
export class EncryptedSheetDatabaseError extends Error {
  public constructor(
    public readonly code: EncryptedSheetDatabaseErrorCode,
    options?: ErrorOptions,
  ) {
    super(SAFE_MESSAGES[code], options);
    this.name = "EncryptedSheetDatabaseError";
  }
}
