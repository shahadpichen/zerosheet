import { describe, expect, it } from "vitest";
import { GoogleStorageConnectionRequiredError } from "./errors.js";
import { AesGcmGoogleRefreshTokenProtector } from "./refresh-token-protector.js";

const firstUser = "d19b70b8-d531-43ac-a734-12270ca484d3";
const secondUser = "3d9a575e-aed9-4634-b9ea-3f00334df680";

describe("AesGcmGoogleRefreshTokenProtector", () => {
  it("round-trips a token through a randomized user-bound envelope", () => {
    const protector = new AesGcmGoogleRefreshTokenProtector(
      Uint8Array.from({ length: 32 }, (_value, index) => index),
    );

    const first = protector.seal(firstUser, "google-refresh-token-value");
    const second = protector.seal(firstUser, "google-refresh-token-value");

    expect(first).not.toBe(second);
    expect(first).not.toContain("google-refresh-token-value");
    expect(protector.open(firstUser, first)).toBe("google-refresh-token-value");
  });

  it("rejects another product user and authenticated-envelope tampering", () => {
    const protector = new AesGcmGoogleRefreshTokenProtector(
      new Uint8Array(32).fill(7),
    );
    const envelope = protector.seal(firstUser, "google-refresh-token-value");
    const finalCharacter = envelope.at(-1);
    const tampered = `${envelope.slice(0, -1)}${finalCharacter === "A" ? "B" : "A"}`;

    expect(() => protector.open(secondUser, envelope)).toThrowError(
      GoogleStorageConnectionRequiredError,
    );
    expect(() => protector.open(firstUser, tampered)).toThrowError(
      GoogleStorageConnectionRequiredError,
    );
  });
});
