import {
  GoogleStorageAccessTokenResponseSchema,
  GoogleStorageErrorResponseSchema,
} from "@zerosheet/contracts";
import {
  AuthorizedGoogleRequest,
  GoogleStorageError,
  GoogleWorkspaceStorage,
  MemoryGoogleAccessTokenProvider,
} from "@zerosheet/google-storage";
import {
  EncryptedSheetSyncSession,
  type SheetCipherContext,
} from "@zerosheet/sheet-core";

/**
 * The adapter requests a short-lived access token from the same-origin BFF.
 * `credentials: same-origin` sends the opaque ZeroSheet session cookie, while
 * browser JavaScript still cannot read that HttpOnly cookie or the encrypted
 * Google refresh token retained by the server.
 */
const accessTokens = new MemoryGoogleAccessTokenProvider({
  fetchToken: async (forceRefresh) => {
    const response = await fetch("/api/google/storage/access-token", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ forceRefresh }),
    });

    if (!response.ok) {
      const error = GoogleStorageErrorResponseSchema.safeParse(
        await response.json().catch(() => null),
      );
      if (error.success && error.data.error === "connection_required") {
        throw new GoogleStorageError("GOOGLE_CONNECTION_REQUIRED");
      }
      if (response.status === 401) {
        throw new GoogleStorageError("GOOGLE_AUTH_EXPIRED");
      }
      throw new GoogleStorageError("GOOGLE_UNAVAILABLE");
    }

    const token = GoogleStorageAccessTokenResponseSchema.parse(
      await response.json(),
    );
    return { value: token.accessToken, expiresAt: new Date(token.expiresAt) };
  },
});

/**
 * The single reviewed Google request boundary fixes every API origin and adds
 * one 401 refresh attempt. Editor code receives storage operations—not a raw
 * bearer token—reducing the number of places that can accidentally leak it.
 */
export const googleWorkspaceStorage = new GoogleWorkspaceStorage(
  new AuthorizedGoogleRequest({ tokens: accessTokens }),
);

/** Clear any short-lived token retained in this page after logout/disconnect. */
export function clearGoogleStorageAccess(): void {
  accessTokens.clear();
}

/**
 * Compose the real Google adapter with the independently tested encrypted sync
 * session. The caller must supply a recovered non-extractable workbook key and
 * stable Google tab identity; this helper never manufactures an unrecoverable
 * key merely to make a storage write possible.
 */
export function createGoogleSheetSyncSession(input: {
  readonly spreadsheetId: string;
  readonly context: SheetCipherContext;
}): EncryptedSheetSyncSession {
  return new EncryptedSheetSyncSession({
    storage: googleWorkspaceStorage,
    spreadsheetId: input.spreadsheetId,
    context: input.context,
  });
}
