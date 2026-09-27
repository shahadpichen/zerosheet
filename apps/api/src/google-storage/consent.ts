import { GoogleStorageOnboardingError } from "./errors.js";
import type { GoogleOAuthTokenResult } from "./types.js";

/**
 * Login and reconnect must ask for the same narrow storage permissions. These
 * cover app-created/explicitly selected spreadsheets and the hidden encrypted
 * key backup, not unrestricted access to every file in the user's Drive.
 */
export const GOOGLE_STORAGE_SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/drive.appdata",
] as const;

export function hasGoogleStorageScopes(scopes: readonly string[]): boolean {
  const granted = new Set(scopes);
  return GOOGLE_STORAGE_SCOPES.every((scope) => granted.has(scope));
}

/**
 * Google can return partial consent or omit a durable refresh token. Neither
 * is enough to promise a storage-connected session. Require fresh authority
 * from this exchange instead of borrowing an older connection that might use
 * a different Google account. Never include token contents in an error.
 */
export function requireGoogleStorageGrant(
  token: GoogleOAuthTokenResult,
): asserts token is GoogleOAuthTokenResult & {
  refreshToken: string;
  grantedScopes: readonly string[];
} {
  if (
    !token.refreshToken ||
    token.refreshToken.length > 8_192 ||
    !/^\S+$/u.test(token.refreshToken) ||
    !token.accessToken ||
    token.accessToken.length > 8_192 ||
    !/^\S+$/u.test(token.accessToken) ||
    !Number.isInteger(token.expiresInSeconds) ||
    token.expiresInSeconds <= 0 ||
    token.expiresInSeconds > 604_800 ||
    !token.grantedScopes ||
    !hasGoogleStorageScopes(token.grantedScopes)
  ) {
    throw new GoogleStorageOnboardingError();
  }
}
