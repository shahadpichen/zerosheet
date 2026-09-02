import { createECDH, createHash } from "node:crypto";
import type {
  UserPublicEncryptionKey,
  WorkbookKeyEnvelope,
} from "@zerosheet/contracts";
import { describe, expect, it } from "vitest";
import { WorkbookSecurityInputError } from "./errors.js";
import {
  assertEnvelopeMatches,
  assertValidUserPublicKey,
  decodeEncryptedPrivateKeyBackup,
} from "./validation.js";

const SUITE = "DHKEM_P256_HKDF_SHA256_HKDF_SHA256_AES_256_GCM" as const;

function publicKey(keyVersion = 1): UserPublicEncryptionKey {
  const ecdh = createECDH("prime256v1");
  const bytes = ecdh.generateKeys();
  return {
    formatVersion: 1,
    keyVersion,
    suite: SUITE,
    publicKey: bytes.toString("base64url"),
    fingerprint: createHash("sha256").update(bytes).digest("hex"),
  };
}

function envelope(
  recipient: UserPublicEncryptionKey,
  workbookKeyVersion = 1,
): WorkbookKeyEnvelope {
  const ephemeral = createECDH("prime256v1");
  return {
    formatVersion: 1,
    suite: SUITE,
    workbookKeyVersion,
    recipientKeyVersion: recipient.keyVersion,
    recipientFingerprint: recipient.fingerprint,
    encapsulatedKey: ephemeral.generateKeys().toString("base64url"),
    ciphertext: Buffer.alloc(48, 9).toString("base64url"),
  };
}

describe("workbook security material validation", () => {
  it("accepts one canonical P-256 directory key and recomputed fingerprint", () => {
    expect(() => assertValidUserPublicKey(publicKey())).not.toThrow();
  });

  it("rejects a substituted fingerprint and malformed P-256 point", () => {
    const valid = publicKey();
    expect(() =>
      assertValidUserPublicKey({ ...valid, fingerprint: "00".repeat(32) }),
    ).toThrow(WorkbookSecurityInputError);
    expect(() =>
      assertValidUserPublicKey({
        ...valid,
        publicKey: Buffer.alloc(65, 4).toString("base64url"),
      }),
    ).toThrow(WorkbookSecurityInputError);
  });

  it("binds each opaque envelope to the exact key and workbook version", () => {
    const recipient = publicKey(4);
    const sealed = envelope(recipient, 7);
    expect(() =>
      assertEnvelopeMatches({
        envelope: sealed,
        workbookKeyVersion: 7,
        recipient,
      }),
    ).not.toThrow();
    expect(() =>
      assertEnvelopeMatches({
        envelope: sealed,
        workbookKeyVersion: 8,
        recipient,
      }),
    ).toThrow(WorkbookSecurityInputError);
  });

  it("decodes only canonical bounded backup transport", () => {
    const backup = Buffer.from("phrase-encrypted-capsule").toString(
      "base64url",
    );
    expect(decodeEncryptedPrivateKeyBackup(backup)).toEqual(
      Uint8Array.from(Buffer.from("phrase-encrypted-capsule")),
    );
    expect(() => decodeEncryptedPrivateKeyBackup(`${backup}=`)).toThrow(
      WorkbookSecurityInputError,
    );
  });
});
