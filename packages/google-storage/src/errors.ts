/**
 * These stable categories let the editor choose a safe recovery action without
 * surfacing Google's response body. Provider errors can contain filenames,
 * account details, request IDs, or attacker-controlled text and therefore do
 * not belong in user-visible exceptions or routine telemetry.
 */
export type GoogleStorageErrorCode =
  | "GOOGLE_CONNECTION_REQUIRED"
  | "GOOGLE_AUTH_EXPIRED"
  | "GOOGLE_PERMISSION_DENIED"
  | "GOOGLE_RESOURCE_NOT_FOUND"
  | "GOOGLE_RATE_LIMITED"
  | "GOOGLE_UNAVAILABLE"
  | "GOOGLE_INVALID_RESPONSE"
  | "GOOGLE_INVALID_INPUT"
  | "GOOGLE_REQUEST_FAILED";

const SAFE_MESSAGES: Record<GoogleStorageErrorCode, string> = {
  GOOGLE_CONNECTION_REQUIRED:
    "Connect Google Drive before using workbook storage.",
  GOOGLE_AUTH_EXPIRED:
    "Google Drive authorization expired. Reconnect and try again.",
  GOOGLE_PERMISSION_DENIED:
    "Google Drive did not allow this operation on the selected file.",
  GOOGLE_RESOURCE_NOT_FOUND: "The Google Drive workbook could not be found.",
  GOOGLE_RATE_LIMITED:
    "Google is temporarily rate limiting workbook requests. Try again shortly.",
  GOOGLE_UNAVAILABLE: "Google Drive or Sheets is temporarily unavailable.",
  GOOGLE_INVALID_RESPONSE:
    "Google returned a response ZeroSheet could not safely understand.",
  GOOGLE_INVALID_INPUT: "The Google storage request is invalid.",
  GOOGLE_REQUEST_FAILED: "The Google storage request failed.",
};

export class GoogleStorageError extends Error {
  public readonly code: GoogleStorageErrorCode;
  public readonly status: number | undefined;

  public constructor(
    code: GoogleStorageErrorCode,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(SAFE_MESSAGES[code]);
    this.name = "GoogleStorageError";
    this.code = code;
    this.status = options.status;

    // The non-enumerable cause is useful to a local debugger but must never be
    // serialized into API responses, analytics, or logs containing tokens.
    if (options.cause !== undefined) {
      Object.defineProperty(this, "cause", {
        configurable: true,
        value: options.cause,
      });
    }
  }
}
