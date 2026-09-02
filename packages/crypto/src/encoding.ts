import { ZeroSheetCryptoError } from "./errors.js";

/** Encode bytes without Node's Buffer so the same source runs in browsers. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

/**
 * Decode only canonical unpadded base64url. Rejecting alternate spellings
 * prevents the same encrypted value from acquiring multiple textual forms.
 */
export function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new ZeroSheetCryptoError("MALFORMED_ENCRYPTED_CELL");
  }

  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
  } catch (error) {
    throw new ZeroSheetCryptoError("MALFORMED_ENCRYPTED_CELL", error);
  }

  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  if (bytesToBase64Url(bytes) !== value) {
    bytes.fill(0);
    throw new ZeroSheetCryptoError("MALFORMED_ENCRYPTED_CELL");
  }

  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/** Compare small secrets without returning at the first differing byte. */
export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] as number) ^ (right[index] as number);
  }
  return difference === 0;
}

/**
 * Reject ASCII control characters without embedding them in a regular
 * expression. IDs become part of authenticated context and logs, so invisible
 * delimiters must not create ambiguous representations or log injection.
 */
export function containsAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}
