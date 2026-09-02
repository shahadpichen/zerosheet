import { ZeroSheetCryptoError } from "./errors.js";

export const WORKBOOK_KEY_BYTES = 32;

/** Generate a fresh AES-256 workbook content key with browser CSPRNG bytes. */
export function generateWorkbookKeyBytes(): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(WORKBOOK_KEY_BYTES));
}

/**
 * Import a raw workbook key as a non-extractable AES-GCM CryptoKey. Callers may
 * temporarily need the raw bytes to create HPKE recipient envelopes, but must
 * clear that byte array immediately after all envelopes are sealed.
 */
export async function importWorkbookKey(
  rawKeyBytes: Uint8Array,
): Promise<CryptoKey> {
  if (rawKeyBytes.byteLength !== WORKBOOK_KEY_BYTES) {
    throw new ZeroSheetCryptoError("INVALID_KEY");
  }

  const copy = Uint8Array.from(rawKeyBytes);
  try {
    return await globalThis.crypto.subtle.importKey(
      "raw",
      copy,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  } catch (error) {
    throw new ZeroSheetCryptoError("INVALID_KEY", error);
  } finally {
    copy.fill(0);
  }
}

/** Fail early if a caller passes an unrelated CryptoKey. */
export function assertWorkbookKey(key: CryptoKey): void {
  if (
    key.type !== "secret" ||
    key.algorithm.name !== "AES-GCM" ||
    key.extractable ||
    !key.usages.includes("encrypt") ||
    !key.usages.includes("decrypt")
  ) {
    throw new ZeroSheetCryptoError("INVALID_KEY");
  }
}
