/**
 * Stable categories let UI and SDK callers offer a recovery action without
 * copying cell content, Google responses, or cryptographic internals into a
 * user-visible error. Coordinates are safe to present separately when useful.
 */
export type SheetCoreErrorCode =
  | "SHEET_INVALID_RANGE"
  | "SHEET_INVALID_CELL"
  | "SHEET_TOO_MANY_CELLS"
  | "SHEET_CORRUPT_CIPHERTEXT"
  | "SHEET_CONFLICT"
  | "SHEET_NOT_LOADED"
  | "SHEET_STORAGE_UNAVAILABLE";

const SAFE_MESSAGES: Record<SheetCoreErrorCode, string> = {
  SHEET_INVALID_RANGE: "The selected spreadsheet range is invalid.",
  SHEET_INVALID_CELL: "A spreadsheet cell cannot be safely synchronized.",
  SHEET_TOO_MANY_CELLS: "The operation contains too many spreadsheet cells.",
  SHEET_CORRUPT_CIPHERTEXT:
    "An encrypted cell is damaged or does not belong at this location.",
  SHEET_CONFLICT:
    "The Google Sheet changed elsewhere. Reload before saving again.",
  SHEET_NOT_LOADED: "Load the Google Sheet before saving changes.",
  SHEET_STORAGE_UNAVAILABLE: "Google Sheet storage is temporarily unavailable.",
};

export class SheetCoreError extends Error {
  public readonly code: SheetCoreErrorCode;
  public readonly coordinate: string | undefined;

  public constructor(
    code: SheetCoreErrorCode,
    options: { readonly coordinate?: string; readonly cause?: unknown } = {},
  ) {
    super(SAFE_MESSAGES[code]);
    this.name = "SheetCoreError";
    this.code = code;
    this.coordinate = options.coordinate;

    // Causes aid a local debugger but remain non-enumerable so serializing the
    // safe public error cannot accidentally include provider or crypto detail.
    if (options.cause !== undefined) {
      Object.defineProperty(this, "cause", {
        configurable: true,
        value: options.cause,
      });
    }
  }
}
