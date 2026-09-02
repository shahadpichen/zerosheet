import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { GoogleStorageConnectionRequiredError } from "./errors.js";
import type { GoogleRefreshTokenProtector } from "./types.js";

const ENVELOPE_VERSION = "v1";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const TOKEN_CONTEXT = "zerosheet:google-storage-refresh-token:v1";

/**
 * AES-256-GCM limits a database-only compromise: a dump does not contain a
 * usable Google refresh token without the independently managed deployment
 * key. A live server operator necessarily can use this key because background
 * Drive permission reconciliation needs delegated Google access; this is not a
 * zero-knowledge workbook key and that residual trust is documented.
 */
export class AesGcmGoogleRefreshTokenProtector implements GoogleRefreshTokenProtector {
  readonly #key: Buffer;

  public constructor(key: Uint8Array) {
    if (key.byteLength !== 32) {
      throw new Error("Google refresh-token encryption key must be 32 bytes");
    }
    this.#key = Buffer.from(key);
  }

  public seal(userId: string, refreshToken: string): string {
    assertUserId(userId);
    assertRefreshToken(refreshToken);
    const nonce = randomBytes(NONCE_BYTES);
    const plaintext = Buffer.from(refreshToken, "utf8");

    try {
      const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
      cipher.setAAD(Buffer.from(`${TOKEN_CONTEXT}:${userId}`, "utf8"));
      const ciphertext = Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();
      try {
        return [
          ENVELOPE_VERSION,
          nonce.toString("base64url"),
          ciphertext.toString("base64url"),
          tag.toString("base64url"),
        ].join(".");
      } finally {
        ciphertext.fill(0);
        tag.fill(0);
      }
    } finally {
      nonce.fill(0);
      plaintext.fill(0);
    }
  }

  public open(userId: string, envelope: string): string {
    assertUserId(userId);
    const parts = envelope.split(".");
    if (
      parts.length !== 4 ||
      parts[0] !== ENVELOPE_VERSION ||
      parts.some((part, index) => index > 0 && !/^[A-Za-z0-9_-]+$/u.test(part))
    ) {
      throw new GoogleStorageConnectionRequiredError();
    }

    const nonce = Buffer.from(parts[1] as string, "base64url");
    const ciphertext = Buffer.from(parts[2] as string, "base64url");
    const tag = Buffer.from(parts[3] as string, "base64url");
    try {
      if (
        nonce.byteLength !== NONCE_BYTES ||
        tag.byteLength !== TAG_BYTES ||
        ciphertext.byteLength < 1 ||
        nonce.toString("base64url") !== parts[1] ||
        ciphertext.toString("base64url") !== parts[2] ||
        tag.toString("base64url") !== parts[3]
      ) {
        throw new GoogleStorageConnectionRequiredError();
      }

      const decipher = createDecipheriv("aes-256-gcm", this.#key, nonce);
      decipher.setAAD(Buffer.from(`${TOKEN_CONTEXT}:${userId}`, "utf8"));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      try {
        const refreshToken = plaintext.toString("utf8");
        assertRefreshToken(refreshToken);
        return refreshToken;
      } finally {
        plaintext.fill(0);
      }
    } catch (error) {
      if (error instanceof GoogleStorageConnectionRequiredError) throw error;
      throw new GoogleStorageConnectionRequiredError();
    } finally {
      nonce.fill(0);
      ciphertext.fill(0);
      tag.fill(0);
    }
  }
}

function assertUserId(userId: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      userId,
    )
  ) {
    throw new GoogleStorageConnectionRequiredError();
  }
}

function assertRefreshToken(refreshToken: string): void {
  if (
    refreshToken.length < 1 ||
    refreshToken.length > 8_192 ||
    /\s/u.test(refreshToken)
  ) {
    throw new GoogleStorageConnectionRequiredError();
  }
}
