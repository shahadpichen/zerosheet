import {
  Aes256Gcm,
  CipherSuite,
  DhkemP256HkdfSha256,
  HkdfSha256,
} from "@hpke/core";
import { CapsuleError, createCapsule, openCapsule } from "@zerodrivehq/capsule";

import {
  base64UrlToBytes,
  bytesEqual,
  bytesToBase64Url,
  bytesToHex,
  containsAsciiControlCharacter,
} from "./encoding.js";
import { ZeroSheetCryptoError } from "./errors.js";
import { normalizeAndValidateRecoveryPhrase } from "./recovery.js";
import { WORKBOOK_KEY_BYTES } from "./workbook-key.js";

/**
 * This exact RFC 9180 ciphersuite is part of the persisted format contract.
 * P-256 is selected because modern browsers implement it in Web Crypto without
 * a custom curve implementation. AES-256-GCM matches the workbook data-key
 * strength and provides authenticated encryption for each wrapped key.
 */
export const USER_HPKE_SUITE =
  "DHKEM_P256_HKDF_SHA256_HKDF_SHA256_AES_256_GCM" as const;
export const USER_PUBLIC_KEY_FORMAT_VERSION = 1 as const;
export const WORKBOOK_KEY_ENVELOPE_VERSION = 1 as const;

const hpkeSuite = new CipherSuite({
  kem: new DhkemP256HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes256Gcm(),
});
const encoder = new TextEncoder();
const keyPairCheckInfo = encoder.encode("zerosheet:hpke-key-pair-check:v1");
const workbookEnvelopeInfo = encoder.encode(
  "zerosheet:workbook-key-envelope:v1",
);

export interface UserPublicEncryptionKey {
  readonly formatVersion: 1;
  readonly keyVersion: number;
  readonly suite: typeof USER_HPKE_SUITE;
  readonly publicKey: string;
  readonly fingerprint: string;
}

export interface CreatedUserEncryptionIdentity {
  readonly publicKey: UserPublicEncryptionKey;
  readonly privateKey: CryptoKey;
  readonly encryptedPrivateKeyBackup: Uint8Array;
}

export interface WorkbookKeyEnvelope {
  readonly formatVersion: 1;
  readonly suite: typeof USER_HPKE_SUITE;
  readonly workbookKeyVersion: number;
  readonly recipientKeyVersion: number;
  readonly recipientFingerprint: string;
  readonly encapsulatedKey: string;
  readonly ciphertext: string;
}

/**
 * Generate the user's HPKE key pair in the browser. The public half is safe for
 * the ZeroSheet directory. The serialized private half exists briefly, is
 * encrypted inside a ZeroDrive Capsule using the 12-word phrase, then wiped.
 */
export async function createUserEncryptionIdentity(input: {
  readonly recoveryPhrase: string;
  readonly keyVersion: number;
  readonly createdAt?: string;
}): Promise<CreatedUserEncryptionIdentity> {
  const recoveryPhrase = normalizeAndValidateRecoveryPhrase(
    input.recoveryPhrase,
  );
  assertKeyVersion(input.keyVersion);

  const keyPair = await hpkeSuite.kem.generateKeyPair();
  const publicKeyBytes = new Uint8Array(
    await hpkeSuite.kem.serializePublicKey(keyPair.publicKey),
  );
  const privateKeyBytes = new Uint8Array(
    await hpkeSuite.kem.serializePrivateKey(keyPair.privateKey),
  );

  try {
    const fingerprint = await fingerprintSerializedPublicKey(publicKeyBytes);
    const publicKey: UserPublicEncryptionKey = {
      formatVersion: USER_PUBLIC_KEY_FORMAT_VERSION,
      keyVersion: input.keyVersion,
      suite: USER_HPKE_SUITE,
      publicKey: bytesToBase64Url(publicKeyBytes),
      fingerprint,
    };
    const created = await createCapsule({
      plaintext: privateKeyBytes,
      recoveryPhrase,
      metadata: {
        name: "zerosheet-hpke-private-key.bin",
        mimeType: "application/vnd.zerosheet.hpke-private-key",
        size: privateKeyBytes.byteLength,
        ...(input.createdAt === undefined
          ? {}
          : { createdAt: input.createdAt }),
        attributes: {
          kind: "zerosheet-hpke-private-key-backup",
          payloadVersion: 1,
          keyVersion: input.keyVersion,
          suite: USER_HPKE_SUITE,
          publicKeyFingerprint: fingerprint,
        },
      },
    });

    return {
      publicKey,
      privateKey: keyPair.privateKey,
      encryptedPrivateKeyBackup: created.bytes,
    };
  } catch (error) {
    if (error instanceof ZeroSheetCryptoError) {
      throw error;
    }
    throw new ZeroSheetCryptoError("ENCRYPTION_FAILED", error);
  } finally {
    publicKeyBytes.fill(0);
    privateKeyBytes.fill(0);
  }
}

/**
 * Open an encrypted private-key backup and prove it matches the separately
 * supplied public directory record. A wrong phrase and damaged backup have
 * distinct safe codes, while all library details stay in the hidden cause.
 */
export async function openUserPrivateKeyBackup(input: {
  readonly encryptedPrivateKeyBackup: Uint8Array;
  readonly recoveryPhrase: string;
  readonly publicKey: UserPublicEncryptionKey;
}): Promise<CryptoKey> {
  const recoveryPhrase = normalizeAndValidateRecoveryPhrase(
    input.recoveryPhrase,
  );
  validateUserPublicKey(input.publicKey);

  let opened: Awaited<ReturnType<typeof openCapsule>>;
  try {
    opened = await openCapsule({
      capsule: input.encryptedPrivateKeyBackup,
      recoveryPhrase,
    });
  } catch (error) {
    throw mapPrivateKeyBackupError(error);
  }

  try {
    const attributes = opened.metadata.attributes;
    if (
      opened.access.kind !== "recovery-phrase" ||
      opened.metadata.name !== "zerosheet-hpke-private-key.bin" ||
      opened.metadata.mimeType !==
        "application/vnd.zerosheet.hpke-private-key" ||
      opened.metadata.size !== opened.plaintext.byteLength ||
      attributes?.kind !== "zerosheet-hpke-private-key-backup" ||
      attributes.payloadVersion !== 1 ||
      attributes.keyVersion !== input.publicKey.keyVersion ||
      attributes.suite !== USER_HPKE_SUITE ||
      attributes.publicKeyFingerprint !== input.publicKey.fingerprint
    ) {
      throw new ZeroSheetCryptoError("PUBLIC_KEY_MISMATCH");
    }

    let privateKey: CryptoKey;
    try {
      privateKey = await hpkeSuite.kem.deserializePrivateKey(opened.plaintext);
    } catch (error) {
      throw new ZeroSheetCryptoError("ENCRYPTED_BACKUP_DAMAGED", error);
    }

    const publicKey = await importUserPublicKey(input.publicKey);
    await assertHpkeKeyPair(publicKey, privateKey);
    return privateKey;
  } finally {
    opened.plaintext.fill(0);
  }
}

/** Import and fingerprint-check a public directory record before sharing. */
export async function importUserPublicKey(
  record: UserPublicEncryptionKey,
): Promise<CryptoKey> {
  validateUserPublicKey(record);
  let bytes: Uint8Array;
  try {
    bytes = base64UrlToBytes(record.publicKey);
  } catch (error) {
    throw new ZeroSheetCryptoError("INVALID_KEY", error);
  }

  try {
    const fingerprint = await fingerprintSerializedPublicKey(bytes);
    if (fingerprint !== record.fingerprint) {
      throw new ZeroSheetCryptoError("INVALID_KEY");
    }
    return await hpkeSuite.kem.deserializePublicKey(bytes);
  } catch (error) {
    if (error instanceof ZeroSheetCryptoError) {
      throw error;
    }
    throw new ZeroSheetCryptoError("INVALID_KEY", error);
  } finally {
    bytes.fill(0);
  }
}

/**
 * Encrypt a random workbook key to one recipient. This primitive is ready now;
 * Milestone 13 adds the authorization, database, rotation, and revocation
 * workflow that decides which recipients receive these envelopes.
 */
export async function sealWorkbookKeyForRecipient(input: {
  readonly workbookId: string;
  readonly workbookKeyVersion: number;
  readonly workbookKeyBytes: Uint8Array;
  readonly recipient: UserPublicEncryptionKey;
}): Promise<WorkbookKeyEnvelope> {
  assertWorkbookEnvelopeContext(
    input.workbookId,
    input.workbookKeyVersion,
    input.recipient,
  );
  if (input.workbookKeyBytes.byteLength !== WORKBOOK_KEY_BYTES) {
    throw new ZeroSheetCryptoError("INVALID_KEY");
  }

  const recipientPublicKey = await importUserPublicKey(input.recipient);
  const additionalData = createWorkbookEnvelopeAdditionalData(
    input.workbookId,
    input.workbookKeyVersion,
    input.recipient,
  );
  const keyCopy = Uint8Array.from(input.workbookKeyBytes);

  try {
    const sealed = await hpkeSuite.seal(
      {
        recipientPublicKey,
        info: workbookEnvelopeInfo,
      },
      keyCopy,
      additionalData,
    );
    const encapsulatedKey = new Uint8Array(sealed.enc);
    const ciphertext = new Uint8Array(sealed.ct);
    try {
      return {
        formatVersion: WORKBOOK_KEY_ENVELOPE_VERSION,
        suite: USER_HPKE_SUITE,
        workbookKeyVersion: input.workbookKeyVersion,
        recipientKeyVersion: input.recipient.keyVersion,
        recipientFingerprint: input.recipient.fingerprint,
        encapsulatedKey: bytesToBase64Url(encapsulatedKey),
        ciphertext: bytesToBase64Url(ciphertext),
      };
    } finally {
      encapsulatedKey.fill(0);
      ciphertext.fill(0);
    }
  } catch (error) {
    if (error instanceof ZeroSheetCryptoError) {
      throw error;
    }
    throw new ZeroSheetCryptoError("ENCRYPTION_FAILED", error);
  } finally {
    additionalData.fill(0);
    keyCopy.fill(0);
  }
}

/** Open one workbook-key envelope only for its exact recipient and context. */
export async function openWorkbookKeyEnvelope(input: {
  readonly workbookId: string;
  readonly envelope: WorkbookKeyEnvelope;
  readonly recipientPublicKey: UserPublicEncryptionKey;
  readonly recipientPrivateKey: CryptoKey;
}): Promise<Uint8Array> {
  validateWorkbookKeyEnvelope(input.envelope);
  assertWorkbookEnvelopeContext(
    input.workbookId,
    input.envelope.workbookKeyVersion,
    input.recipientPublicKey,
  );
  if (
    input.envelope.recipientKeyVersion !==
      input.recipientPublicKey.keyVersion ||
    input.envelope.recipientFingerprint !== input.recipientPublicKey.fingerprint
  ) {
    throw new ZeroSheetCryptoError("PUBLIC_KEY_MISMATCH");
  }

  const additionalData = createWorkbookEnvelopeAdditionalData(
    input.workbookId,
    input.envelope.workbookKeyVersion,
    input.recipientPublicKey,
  );
  let encapsulatedKey: Uint8Array;
  let ciphertext: Uint8Array;
  try {
    encapsulatedKey = base64UrlToBytes(input.envelope.encapsulatedKey);
    ciphertext = base64UrlToBytes(input.envelope.ciphertext);
  } catch (error) {
    additionalData.fill(0);
    throw new ZeroSheetCryptoError("HPKE_OPEN_FAILED", error);
  }

  try {
    const plaintext = new Uint8Array(
      await hpkeSuite.open(
        {
          recipientKey: input.recipientPrivateKey,
          enc: encapsulatedKey,
          info: workbookEnvelopeInfo,
        },
        ciphertext,
        additionalData,
      ),
    );
    if (plaintext.byteLength !== WORKBOOK_KEY_BYTES) {
      plaintext.fill(0);
      throw new ZeroSheetCryptoError("HPKE_OPEN_FAILED");
    }
    return plaintext;
  } catch (error) {
    if (error instanceof ZeroSheetCryptoError) {
      throw error;
    }
    throw new ZeroSheetCryptoError("HPKE_OPEN_FAILED", error);
  } finally {
    additionalData.fill(0);
    encapsulatedKey.fill(0);
    ciphertext.fill(0);
  }
}

async function fingerprintSerializedPublicKey(
  publicKeyBytes: Uint8Array,
): Promise<string> {
  const publicKeyCopy = Uint8Array.from(publicKeyBytes);
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", publicKeyCopy),
  );
  try {
    return bytesToHex(digest);
  } finally {
    publicKeyCopy.fill(0);
    digest.fill(0);
  }
}

async function assertHpkeKeyPair(
  publicKey: CryptoKey,
  privateKey: CryptoKey,
): Promise<void> {
  const challenge = Uint8Array.from({ length: 32 }, (_value, index) => index);
  const aad = encoder.encode("zerosheet:hpke-key-pair-check:aad:v1");
  let opened: Uint8Array | undefined;

  try {
    const sealed = await hpkeSuite.seal(
      { recipientPublicKey: publicKey, info: keyPairCheckInfo },
      challenge,
      aad,
    );
    opened = new Uint8Array(
      await hpkeSuite.open(
        {
          recipientKey: privateKey,
          enc: sealed.enc,
          info: keyPairCheckInfo,
        },
        sealed.ct,
        aad,
      ),
    );
    if (!bytesEqual(challenge, opened)) {
      throw new Error("key pair challenge mismatch");
    }
  } catch (error) {
    throw new ZeroSheetCryptoError("PUBLIC_KEY_MISMATCH", error);
  } finally {
    challenge.fill(0);
    aad.fill(0);
    opened?.fill(0);
  }
}

function mapPrivateKeyBackupError(error: unknown): ZeroSheetCryptoError {
  if (error instanceof CapsuleError) {
    if (error.code === "INVALID_RECOVERY_PHRASE") {
      return new ZeroSheetCryptoError("INVALID_RECOVERY_PHRASE", error);
    }
    if (
      error.code === "CAPSULE_KEY_UNWRAP_FAILED" ||
      error.code === "CAPSULE_NO_MATCHING_KEY"
    ) {
      return new ZeroSheetCryptoError("RECOVERY_PHRASE_MISMATCH", error);
    }
  }
  return new ZeroSheetCryptoError("ENCRYPTED_BACKUP_DAMAGED", error);
}

function validateUserPublicKey(record: UserPublicEncryptionKey): void {
  assertKeyVersion(record.keyVersion);
  if (
    record.formatVersion !== USER_PUBLIC_KEY_FORMAT_VERSION ||
    record.suite !== USER_HPKE_SUITE ||
    !/^[0-9a-f]{64}$/u.test(record.fingerprint) ||
    !/^[A-Za-z0-9_-]+$/u.test(record.publicKey)
  ) {
    throw new ZeroSheetCryptoError("INVALID_KEY");
  }
}

function validateWorkbookKeyEnvelope(envelope: WorkbookKeyEnvelope): void {
  if (
    envelope.formatVersion !== WORKBOOK_KEY_ENVELOPE_VERSION ||
    envelope.suite !== USER_HPKE_SUITE ||
    !/^[0-9a-f]{64}$/u.test(envelope.recipientFingerprint) ||
    !/^[A-Za-z0-9_-]+$/u.test(envelope.encapsulatedKey) ||
    !/^[A-Za-z0-9_-]+$/u.test(envelope.ciphertext)
  ) {
    throw new ZeroSheetCryptoError("HPKE_OPEN_FAILED");
  }
  assertKeyVersion(envelope.workbookKeyVersion);
  assertKeyVersion(envelope.recipientKeyVersion);
}

function assertWorkbookEnvelopeContext(
  workbookId: string,
  workbookKeyVersion: number,
  recipient: UserPublicEncryptionKey,
): void {
  validateUserPublicKey(recipient);
  assertKeyVersion(workbookKeyVersion);
  if (
    workbookId.length < 1 ||
    workbookId.length > 512 ||
    workbookId.trim() !== workbookId ||
    containsAsciiControlCharacter(workbookId)
  ) {
    throw new ZeroSheetCryptoError("INVALID_CONTEXT");
  }
}

function createWorkbookEnvelopeAdditionalData(
  workbookId: string,
  workbookKeyVersion: number,
  recipient: UserPublicEncryptionKey,
): Uint8Array {
  return encoder.encode(
    JSON.stringify([
      "zerosheet:workbook-key-envelope",
      WORKBOOK_KEY_ENVELOPE_VERSION,
      USER_HPKE_SUITE,
      workbookId,
      workbookKeyVersion,
      recipient.keyVersion,
      recipient.fingerprint,
    ]),
  );
}

function assertKeyVersion(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 0xffff_ffff) {
    throw new ZeroSheetCryptoError("INVALID_KEY");
  }
}
