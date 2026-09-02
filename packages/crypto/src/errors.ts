/**
 * Stable error codes let UI code explain the safe next action without exposing
 * low-level Web Crypto errors, plaintext, keys, or attacker-controlled bytes.
 */
export type ZeroSheetCryptoErrorCode =
  | "INVALID_RECOVERY_PHRASE"
  | "RECOVERY_PHRASE_MISMATCH"
  | "RECOVERY_ACCESS_REQUIRED"
  | "RECOVERY_ACCOUNT_MISMATCH"
  | "INVALID_KEY"
  | "INVALID_CONTEXT"
  | "MALFORMED_ENCRYPTED_CELL"
  | "UNSUPPORTED_ENCRYPTED_FORMAT"
  | "CELL_AUTHENTICATION_FAILED"
  | "ENCRYPTION_FAILED"
  | "ENCRYPTED_BACKUP_DAMAGED"
  | "PUBLIC_KEY_MISMATCH"
  | "HPKE_OPEN_FAILED";

const SAFE_MESSAGES: Record<ZeroSheetCryptoErrorCode, string> = {
  INVALID_RECOVERY_PHRASE:
    "The recovery phrase is invalid. Check all 12 words and their order.",
  RECOVERY_PHRASE_MISMATCH:
    "This recovery phrase cannot open the encrypted private key.",
  RECOVERY_ACCESS_REQUIRED:
    "Enter the recovery phrase for this account before continuing.",
  RECOVERY_ACCOUNT_MISMATCH:
    "Recovery access belongs to a different signed-in account.",
  INVALID_KEY: "The encryption key is invalid or unsupported.",
  INVALID_CONTEXT: "The encrypted cell context is invalid.",
  MALFORMED_ENCRYPTED_CELL: "The encrypted cell is incomplete or malformed.",
  UNSUPPORTED_ENCRYPTED_FORMAT:
    "This encrypted cell version is not supported by this client.",
  CELL_AUTHENTICATION_FAILED:
    "The encrypted cell could not be verified in this workbook location.",
  ENCRYPTION_FAILED: "The browser could not encrypt this value.",
  ENCRYPTED_BACKUP_DAMAGED:
    "The encrypted private-key backup is incomplete or damaged.",
  PUBLIC_KEY_MISMATCH:
    "The encrypted private key does not match the published public key.",
  HPKE_OPEN_FAILED: "This user key cannot open the workbook-key envelope.",
};

export class ZeroSheetCryptoError extends Error {
  public readonly code: ZeroSheetCryptoErrorCode;

  public constructor(code: ZeroSheetCryptoErrorCode, cause?: unknown) {
    super(SAFE_MESSAGES[code]);
    this.name = "ZeroSheetCryptoError";
    this.code = code;

    // The cause is non-enumerable so accidental JSON serialization does not
    // expose browser/library diagnostic data. Production telemetry must record
    // only `code`, never the cause or the original cryptographic inputs.
    if (cause !== undefined) {
      Object.defineProperty(this, "cause", {
        configurable: true,
        value: cause,
      });
    }
  }
}
