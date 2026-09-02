import { createHash, ECDH } from "node:crypto";
import type {
  UserPublicEncryptionKey,
  WorkbookKeyEnvelope,
} from "@zerosheet/contracts";
import { WorkbookSecurityInputError } from "./errors.js";

const P256_UNCOMPRESSED_PUBLIC_KEY_BYTES = 65;
const WORKBOOK_KEY_CIPHERTEXT_BYTES = 32 + 16;
const MAX_ENCRYPTED_PRIVATE_KEY_BACKUP_BYTES = 256 * 1024;

/**
 * Zod validates the transport shape; this function validates cryptographic
 * structure and independently recomputes the directory fingerprint. A caller
 * therefore cannot register arbitrary bytes under another fingerprint.
 */
export function assertValidUserPublicKey(
  record: UserPublicEncryptionKey,
): void {
  const bytes = decodeCanonicalBase64Url(record.publicKey);
  try {
    assertP256Point(bytes);
    const fingerprint = createHash("sha256").update(bytes).digest("hex");
    if (fingerprint !== record.fingerprint) {
      throw new WorkbookSecurityInputError();
    }
  } finally {
    bytes.fill(0);
  }
}

export function decodeEncryptedPrivateKeyBackup(value: string): Uint8Array {
  const bytes = decodeCanonicalBase64Url(value);
  if (
    bytes.byteLength < 1 ||
    bytes.byteLength > MAX_ENCRYPTED_PRIVATE_KEY_BACKUP_BYTES
  ) {
    bytes.fill(0);
    throw new WorkbookSecurityInputError();
  }
  return bytes;
}

/**
 * The server cannot decrypt an HPKE envelope, but it can enforce its exact
 * recipient binding, version, canonical encoding, P-256 encapsulated point,
 * and the fixed 32-byte-key-plus-16-byte-tag ciphertext length.
 */
export function assertEnvelopeMatches(input: {
  readonly envelope: WorkbookKeyEnvelope;
  readonly workbookKeyVersion: number;
  readonly recipient: UserPublicEncryptionKey;
}): void {
  const { envelope, recipient, workbookKeyVersion } = input;
  if (
    envelope.workbookKeyVersion !== workbookKeyVersion ||
    envelope.recipientKeyVersion !== recipient.keyVersion ||
    envelope.recipientFingerprint !== recipient.fingerprint ||
    envelope.suite !== recipient.suite
  ) {
    throw new WorkbookSecurityInputError();
  }

  const encapsulatedKey = decodeCanonicalBase64Url(envelope.encapsulatedKey);
  const ciphertext = decodeCanonicalBase64Url(envelope.ciphertext);
  try {
    assertP256Point(encapsulatedKey);
    if (ciphertext.byteLength !== WORKBOOK_KEY_CIPHERTEXT_BYTES) {
      throw new WorkbookSecurityInputError();
    }
  } finally {
    encapsulatedKey.fill(0);
    ciphertext.fill(0);
  }
}

function assertP256Point(bytes: Uint8Array): void {
  if (
    bytes.byteLength !== P256_UNCOMPRESSED_PUBLIC_KEY_BYTES ||
    bytes[0] !== 0x04
  ) {
    throw new WorkbookSecurityInputError();
  }
  try {
    ECDH.convertKey(bytes, "prime256v1", undefined, undefined, "uncompressed");
  } catch {
    throw new WorkbookSecurityInputError();
  }
}

function decodeCanonicalBase64Url(value: string): Uint8Array {
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) {
      throw new WorkbookSecurityInputError();
    }
    return Uint8Array.from(bytes);
  } catch (error) {
    if (error instanceof WorkbookSecurityInputError) throw error;
    throw new WorkbookSecurityInputError();
  }
}
