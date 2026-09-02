/**
 * Public exports keep Google OAuth credentials outside this package. The
 * application supplies a narrow access-token provider while storage code is
 * limited to fixed Google API origins and ciphertext-safe operations.
 */
export { MemoryGoogleAccessTokenProvider } from "./access-token-provider.js";
export { GoogleStorageError, type GoogleStorageErrorCode } from "./errors.js";
export { AuthorizedGoogleRequest } from "./request.js";
export { GoogleWorkspaceStorage } from "./storage.js";
export {
  GOOGLE_DRIVE_APPDATA_SCOPE,
  GOOGLE_DRIVE_FILE_SCOPE,
  GOOGLE_STORAGE_REQUIRED_SCOPES,
  type GoogleAccessToken,
  type GoogleAccessTokenProvider,
  type GoogleCellScalar,
  type GoogleReadRange,
  type GoogleSpreadsheetFile,
  type GoogleValueRange,
} from "./types.js";
